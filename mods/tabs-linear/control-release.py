"""Wait for macOS Control release, including release before the view takes focus."""
import ctypes
import time

core = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
core.CGEventSourceFlagsState.argtypes = [ctypes.c_int]
core.CGEventSourceFlagsState.restype = ctypes.c_uint64
deadline = time.monotonic() + 60
while core.CGEventSourceFlagsState(0) & (1 << 18):
    if time.monotonic() >= deadline:
        print("timeout")
        break
    time.sleep(0.02)
else:
    print("released")
