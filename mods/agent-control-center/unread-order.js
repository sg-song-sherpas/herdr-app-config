import {worktreePriority} from './worktree-priority.js';
// One ordering for the panel and its keyboard navigation.
export function orderUnreadCards(cards,allSpaces,priorities) {
 const bySpace=new Map(allSpaces.map(space=>[space.id,space]));
 const rank={high:0,normal:1,low:2};
 return cards.map((card,index)=>({card,index,priority:rank[worktreePriority(priorities,bySpace.get(card.agent.space))],
  reading:Number.isFinite(card.value?.rank)?card.value.rank:3}))
  .sort((a,b)=>a.priority-b.priority||a.reading-b.reading||a.index-b.index).map(item=>item.card);
}
export function takeNextUnread(cards,pending,now=Date.now()) {
 const live=new Set(cards.map(card=>card.key));
 for(const [key,until] of pending)if(!live.has(key)||until<=now)pending.delete(key);
 const card=cards.find(item=>!pending.has(item.key));
 if(card)pending.set(card.key,now+1500);
 return card??null;
}
