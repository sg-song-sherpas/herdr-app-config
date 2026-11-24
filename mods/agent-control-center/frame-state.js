// Herdr shared() materializes a new JS object tree on every read.
// Keep one copy during a synchronous frame and release it even if rendering fails.
export function createFrameStateReader(read) {
  let depth = 0, hasValue = false, value;
  return {
    get() {
      if (!depth) return read();
      if (!hasValue) {
        value = read();
        hasValue = true;
      }
      return value;
    },
    frame(render) {
      depth++;
      try {
        return render();
      } finally {
        if (--depth === 0) {
          hasValue = false;
          value = undefined;
        }
      }
    },
  };
}
