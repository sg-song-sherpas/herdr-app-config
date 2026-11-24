"""Local bridge. Credentials never leave memory except in HTTPS auth headers."""
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request
import uuid

BASE = 'https://chatgpt.com/backend-api/wham/'


def request(path, tokens, body=None):
    headers = {'Authorization': 'Bearer ' + tokens['access_token'], 'Accept': 'application/json', 'User-Agent': 'Herdr-Usage/1.0'}
    if tokens.get('account_id'):
        headers['ChatGPT-Account-ID'] = tokens['account_id']
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response)


def ticket_fields(value):
    if not isinstance(value, dict):
        return None
    result = {k: value[k] for k in ('available_count', 'total_earned_count') if k in value}
    if isinstance(value.get('credits'), list):
        result['credits'] = [{k: c[k] for k in ('status', 'expires_at', 'granted_at') if k in c} for c in value['credits'] if isinstance(c, dict)]
    return result


def window_fields(value):
    if not isinstance(value, dict):
        return None
    return {k: value[k] for k in ('used_percent', 'limit_window_seconds', 'reset_at') if k in value}


def main():
    auth = json.loads((Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'auth.json').read_text())
    tokens = auth.get('tokens') or {}
    if not tokens.get('access_token'):
        raise ValueError('login')
    action = sys.argv[1] if len(sys.argv) > 1 else 'read'
    if action == 'consume':
        # Stable id supplied by the view is reused if a timed-out operation is retried.
        key = str(uuid.UUID(sys.argv[2]))
        response = request('rate-limit-reset-credits/consume', tokens, {'redeem_request_id': key})
        return {'outcome': response.get('code', 'unknown')}
    if action != 'read':
        raise ValueError('action')
    raw = request('usage', tokens)
    limits = raw.get('rate_limit') or {}
    result = {'usage': {'plan_type': raw.get('plan_type'), 'rate_limit': {k: window_fields(limits.get(k)) for k in ('primary_window', 'secondary_window')}}}
    result['tickets'] = ticket_fields(raw.get('rate_limit_reset_credits'))
    if result['tickets'] is None or 'credits' not in result['tickets']:
        try:
            details = ticket_fields(request('rate-limit-reset-credits', tokens))
            if details is not None:
                result['tickets'] = {**(result['tickets'] or {}), **details}
        except Exception:
            result['ticketError'] = '초기화 티켓을 조회할 수 없습니다.'
    return result


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Exception as error:
        if isinstance(error, urllib.error.HTTPError):
            message = 'Codex 로그인을 다시 확인해주세요.' if error.code in (401, 403) else '사용량 서버 응답 오류 (' + str(error.code) + ')'
        elif isinstance(error, (ValueError, FileNotFoundError, KeyError)):
            message = 'Codex CLI에 ChatGPT 계정으로 로그인해주세요.'
        else:
            message = '사용량 조회에 실패했습니다. 네트워크 연결을 확인해주세요.'
        print(json.dumps({'error': message}, ensure_ascii=False))
        sys.exit(1)
