import { leadPanes, tabTitle } from './task-label.js';

// Tabs own their rows. Split agent panes must not produce duplicate tab rows.
export function tabEntries(allSpaces, allPanes, allAgents) {
  const leads = leadPanes(allPanes), firstPane = new Map(), byAddress = new Map();
  const agentsByTab = new Map();
  for (const pane of allPanes) if (!firstPane.has(pane.tab)) firstPane.set(pane.tab, pane);
  for (const agent of allAgents) {
    byAddress.set(agent.address, agent);
    if (!agentsByTab.has(agent.tab)) agentsByTab.set(agent.tab, []);
    agentsByTab.get(agent.tab).push(agent);
  }
  return allSpaces.flatMap(space => (space.tabs ?? []).map(tab => {
    const lead = leads.get(tab.id) ?? firstPane.get(tab.id);
    const tabAgents = agentsByTab.get(tab.id) ?? [];
    const a = byAddress.get(lead?.terminal) ?? tabAgents[0] ?? null;
    const label = tabTitle(tab, lead, space.name);
    const name = !tab.named && /^(?:tb)?\d+$/.test(label) ? lead?.program?.name || lead?.mod || 'Terminal' : label;
    return { tab, space, lead, a, agents: tabAgents, name };
  }));
}

export function tabStarred(entry, agentStars = {}, tabStars = {}) {
  // A tab keeps its explicit choice when the process changes into an agent.
  if (typeof tabStars?.[entry.tab.id] === 'boolean') return tabStars[entry.tab.id];
  return entry.agents.some(agent => agentStars?.[agent.address]);
}

export function pickTabs(state, id, visible, {toggle = false, range = false} = {}) {
  const live = new Set(visible), selected = new Set((state.ids ?? []).filter(id => live.has(id)));
  if (!live.has(id)) return {ids:[...selected],anchor:state.anchor};
  const anchor = live.has(state.anchor) ? state.anchor : id;
  if (range) {
    const a=visible.indexOf(anchor), b=visible.indexOf(id);
    const interval = new Set(visible.slice(Math.min(a,b),Math.max(a,b)+1));
    return {ids:visible.filter(key=>interval.has(key)||(toggle&&selected.has(key))),anchor};
  }
  if (toggle) {
    selected.has(id) ? selected.delete(id) : selected.add(id);
    return {ids:visible.filter(key=>selected.has(key)),anchor:id};
  }
  return {ids:[id],anchor:id};
}

export function tabDropPlan(allSpaces, ids, over, after) {
  const unique = new Set(ids);
  const target = allSpaces.find(space => space.tabs.some(tab=>tab.id===over));
  if (!target || !unique.size || unique.has(over)) return null;
  const tabs = target.tabs.map(tab=>tab.id);
  if ([...unique].some(id=>!tabs.includes(id))) return null;
  const moving=tabs.filter(id=>unique.has(id)), remaining=tabs.filter(id=>!unique.has(id));
  const at=remaining.indexOf(over)+(after?1:0);
  const order=[...remaining.slice(0,at),...moving,...remaining.slice(at)];
  const current=[...tabs], moves=[];
  for(let i=0;i<order.length;i++) {
    const from=current.indexOf(order[i]);
    if(from===i)continue;
    moves.push({id:order[i],index:i+1});
    current.splice(i,0,current.splice(from,1)[0]);
  }
  return {space:target.id,order,moves};
}

// The empty tab-bar area is an insertion position after all remaining tabs.
export function tabEndPlan(allSpaces, ids, spaceId) {
  const target = allSpaces.find(space => space.id === spaceId);
  const moving = new Set(ids);
  if (!target || !moving.size) return null;
  const live = new Set(target.tabs.map(tab => tab.id));
  if ([...moving].some(id => !live.has(id))) return null;
  const last = target.tabs.filter(tab => !moving.has(tab.id)).at(-1);
  return last ? tabDropPlan(allSpaces, ids, last.id, true) : null;
}

// Inactive spaces retain their own active tab; only the active space is visible.
export function activeTabContext(allSpaces) {
  const space = allSpaces.find(space => space.active);
  return space ? JSON.stringify([space.id, space.tabs.find(tab => tab.active)?.id ?? null]) : null;
}

// Keep legacy agent choices on the tab before terminals disappear at restart.
// Wait for discovery before recording false, so a late agent snapshot is safe.
export function rememberTabStars(allAgents, agentStars = {}, tabStars = {}, known = {}) {
  const byTab = new Map();
  for (const agent of allAgents) {
    if (!agent.tab) continue;
    if (!byTab.has(agent.tab)) byTab.set(agent.tab, []);
    byTab.get(agent.tab).push(agent.address);
  }
  let next = tabStars;
  for (const [tab, addresses] of byTab) {
    if (typeof tabStars[tab] === 'boolean') continue;
    const starred = addresses.some(address => agentStars[address] === true);
    if (!starred && !addresses.every(address => known[address] === true)) continue;
    if (next === tabStars) next = {...tabStars};
    next[tab] = starred;
  }
  return next;
}

// A blue tier supplements the existing boolean favorite contract.
export function tabStarTier(entry, agentStars={}, tabStars={}, blueStars={}) {
  if (!tabStarred(entry, agentStars, tabStars)) return "none";
  return blueStars[entry.tab.id] === true ? "blue" : "yellow";
}
export function matchesStarFilter(tier, enabled, filterTier="all") {
  return !enabled || (filterTier === "blue" ? tier === "blue" : tier !== "none");
}
export function blueStarChange(stars, id, blue) {
  const next = {...stars};
  if (blue) next[id] = true; else delete next[id];
  return next;
}
