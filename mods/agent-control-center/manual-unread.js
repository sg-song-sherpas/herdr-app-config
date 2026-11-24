export const MANUAL_UNREAD_LABEL = 'acc.manual-unread';
const normalize = value => {
 const t = value?.terminal && typeof value.terminal === 'object' ? value.terminal : value;
 return t ? {...t,status:typeof t.status === 'object'?t.status?.state:t.status} : null;
};
export function unreadIdentity(t) {
 return JSON.stringify([t?.address,t?.created_ms??t?.created??'',t?.pid??'',t?.foreground?.pid??'']);
}
export function manualUnread(t) {
 if (!t || !['idle','done'].includes(normalize(t)?.status) || !Number.isInteger(t.turn) || t.turn<=0) return false;
 try {
  const raw=t.labels?.[MANUAL_UNREAD_LABEL];if(typeof raw!=='string'||raw.length>1000)return false;
  const pin=JSON.parse(raw);
  return pin?.turn===t.turn && pin.identity===unreadIdentity(t);
 }catch{return false;}
}
export function unreadStatus(status,t) {
 return ['idle','done'].includes(status)&&manualUnread(t)?'done':status;
}
async function getTerminal(call,address) {
 const result=await call(['get',address,'--json']);
 if(result.code!==0)throw new Error(result.stderr||result.stdout||'세션 상태를 확인하지 못했습니다.');
 return normalize(JSON.parse(result.stdout));
}
export async function markUnread(expected,call) {
 const live=await getTerminal(call,expected.address);
 if(unreadIdentity(live)!==unreadIdentity(expected)||live.turn!==expected.turn||!['idle','done'].includes(live.status)||!(live.turn>0))
  throw new Error('응답이나 세션이 변경됐습니다. 현재 상태를 다시 확인해 주세요.');
 const pin={turn:live.turn,identity:unreadIdentity(live)};
 const result=await call(['label',live.address,`herdr.seen=${live.turn-1}`,`${MANUAL_UNREAD_LABEL}=${JSON.stringify(pin)}`]);
 if(result.code!==0)throw new Error(result.stderr||result.stdout||'미확인으로 표시하지 못했습니다.');
 const after=await getTerminal(call,live.address);
 if(!manualUnread(after))throw new Error('미확인 표시를 저장하지 못했거나 새 응답이 시작됐습니다.');
 return after;
}
export async function clearManualUnread(expected,call) {
 if(!manualUnread(expected))return false;
 const live=await getTerminal(call,expected.address);
 if(!manualUnread(live)||unreadIdentity(live)!==unreadIdentity(expected)||live.turn!==expected.turn)return false;
 const result=await call(['label',live.address,`herdr.seen=${live.turn}`,`${MANUAL_UNREAD_LABEL}=`]);
 if(result.code!==0)throw new Error(result.stderr||result.stdout||'읽음 표시를 저장하지 못했습니다.');
 return true;
}
