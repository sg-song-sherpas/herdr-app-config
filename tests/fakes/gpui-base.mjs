// Fake "gpui-base" for tests.
import { el } from "./element.mjs";

export const h_flex = () => el("h_flex");
export const v_flex = () => el("v_flex");
export const Popup = { new: (id, trigger) => el("popup").id(id).child(trigger) };
export const TextView = (...args) => el("text_view", args);
TextView.markdown = (id, value) => el("text_view").id(id).child(value);

// An input's retained state. Tests type with `state.type("abc", cx)` and press
// Enter with `state.submit(cx)`.
export const InputState = {
  new(options = {}) {
    let value = options.value ?? "";
    const on = {};
    return {
      placeholder: options.placeholder,
      focused: false,
      value: () => value,
      set_value(v) { value = String(v); },
      replace(v) { value = String(v); },
      on(event, fn) { on[event] = fn; return true; },
      focus() { this.focused = true; },
      release() { return true; },
      set_soft_wrap(wrap) { this.softWrap = wrap; },
      set_auto_grow(min, max) { this.autoGrow = [min, max]; },
      set_step() {}, set_min() {}, set_max() {}, set_masked() {}, set_loading() {},
      type(text, cx) { value = text; on.change?.({}, cx); },
      submit(cx) { on.submit?.({}, cx); },
    };
  },
};
export const Input = { new: (state) => el("input", state) };
export const TextareaState = InputState;
export const Textarea = { new: (state) => el("textarea", state) };
export const NumberInput = { new: (state) => el("number_input", state) };
export const Scrollbar = { vertical: (id) => el("scrollbar").id(id) };
export const EditorState = { new(options = {}) {
  return { ...InputState.new(options), options, go_to_line(line) { this.line = line; } };
} };
export const Editor = { new: state => el('editor', state) };
export const VirtualListScrollHandle = { new: () => ({
  scroll_to_item(index, strategy) { this.index = index; this.strategy = strategy; },
  release() { this.released = true; return true; },
}) };
export const v_virtual_list = (id, count, size, key, render) => el('v_virtual_list', {count,size,key}).id(id)
  .children(render({start:0,end:Math.min(count,100)}));
