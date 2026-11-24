// Read-only branch changes since the main fork, including tracked work-in-progress.
export function parseNumstat(text) {
 const fields=text.split('\0');let added=0,deleted=0,binary=0;
 for(let i=0;i<fields.length;i++){
  const match=/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]);
  if(!match)continue;
  if(match[1]==='-'||match[2]==='-')binary++;
  else{added+=Number(match[1]);deleted+=Number(match[2]);}
  if(match[3]==='')i+=2; // Renames carry two extra NUL-terminated paths.
 }
 return {added,deleted,binary};
}
export async function readMainDiff(exec,cwd,on) {
 for(const reference of ['refs/remotes/origin/main','refs/heads/main']){
  const base=await exec('git',['merge-base',reference,'HEAD'],{cwd,on,timeout:10000});
  if(base.code!==0)continue;
  const oid=base.stdout.trim();if(!/^[a-f0-9]{40,64}$/.test(oid))continue;
  const diff=await exec('git',['--no-optional-locks','diff','--no-ext-diff','--no-textconv','--numstat','-z',oid,'--'],{cwd,on,timeout:15000});
  if(diff.code!==0)return {state:'unknown',reason:'main 대비 변경 조회 실패'};
  return {state:'ready',reference,base:oid,...parseNumstat(diff.stdout)};
 }
 return {state:'unknown',reason:'main 기준 브랜치 없음'};
}
