import {shared,setShared,closeOverlay} from 'herdr';
// One transient UI lease; it holds only an overlay id, never notes or task data.
export const HOVER_CARD_LEASE='acc.hover-card';
export function releaseHoverLease(id) {
 if(id&&shared(HOVER_CARD_LEASE)?.id===id)setShared(HOVER_CARD_LEASE,null);
}
export function dismissHoverOverlay(id) {
 if(typeof id!=='string'||!id)return;
 releaseHoverLease(id);
 closeOverlay(id);
}
export function hoverAnchorKey(machine,spaceId,tabId) {
 return JSON.stringify([machine||null,spaceId||null,tabId||null]);
}
function visibleSidebar(node,hidden=false) {
 if(!node||typeof node!=='object')return null;
 hidden=hidden||node.hidden===true;
 if(node.id==='sidebar')return hidden?null:node;
 for(const child of node.children??[]){const found=visibleSidebar(child,hidden);if(found)return found;}
 return null;
}
export function hoverContextToken({spaceId,tabId,allSpaces,focus,layout,filters,viewport,bounds}) {
 const space=allSpaces.find(s=>s.id===spaceId);
 const tab=tabId?space?.tabs?.find(t=>t.id===tabId):null;
 const sidebar=visibleSidebar(layout);
 if(!space||(tabId&&!tab)||!sidebar)return null;
 return JSON.stringify([spaceId,tabId,space.name,tab?.name,
  [focus?.space,focus?.tab,focus?.pane,focus?.terminal,focus?.shown],
  sidebar,filters,viewport,bounds,allSpaces.map(s=>[s.id,(s.tabs??[]).map(t=>t.id)])]);
}
