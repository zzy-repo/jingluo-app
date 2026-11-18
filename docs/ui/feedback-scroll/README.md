# Feedback touch-scroll regression

Base: published origin/main d593312 (1.4.0-beta.7). Isolated worktree fix/feedback-scroll; independent static server 127.0.0.1:5418, dist-scroll. No Android build/device restart/release.

## Reproduction and cause

Current Chromium baseline 360×640 does scroll using CDP Input.dispatchTouchEvent (main scrollHeight744/clientHeight384, scrollTop0→360). The issue is not proven to be solely an old WebView defect.

Removing parsed CSS declarations containing dvh simulates missing dynamic viewport CSS support, not an actual old engine: baseline main744/744, dialog bounds -164..804, submit742..782, touch scrollTop0→0. Existing document touchmove lock then correctly finds no overflowing ancestor and prevents document scrolling; body is intentionally locked by the app. Height constraints must exist, rather than disabling locks.

Separately, visualViewport.height=340 with layout viewport640 left the baseline submit562..602 under the simulated keyboard. Modal is a body portal, outside the app frame on which the existing keyboard viewport variables are set.

## Minimal fix

Use vh plus Modal-provided available viewport height; main min-height0/flex shrink, non-shrinking body preserving scroll extent. Keep header/actions from shrinking, move existing log warnings into scroll content, preserve every field, allow pan-y and contain overscroll, safe-area bottom padding. No new global overflow lock or document touch-event changes.

## Method and boundaries

The focused Playwright script sends native Chromium CDP touchStart/touchMove/touchEnd at 12 intermediate points, and logs the actual element/class at the touch origin, dimensions, computed overflow and scroll offsets. No wheel or scrollTop assignment is used for scroll assertions. Locator tap/auto-scroll is only used for setup/actions; measured first-to-last/last-to-first movement uses CDP touch.

Cases: 360×640, 360×780, 393×851; 1×/1.3×/1.5× computed font/line-height scaling without page zoom; missing-dvh CSS simulation; visualViewport340 keyboard simulation. Expand 20 logs/integrity, attach image, touch back to export and tap save, touch to bottom, close nested feedback and touch parent Settings, then close Settings and touch main message scroller in the three normal viewport cases. JSON records evidence. Main restoration is not asserted in the missing-dvh simulation: removing dvh globally also breaks the unrelated App frame height; nor in the keyboard mock which intentionally stays at340 after dialog close. The baseline log predates the stable-mount harness correction (normal-font baseline is still valid; missing-dvh and keyboard baseline font scaling did not apply because dialog mounting raced). Corrected post-fix cases explicitly wait for description mount before applying font scaling.

Parent manually inspected before missing-dvh plus after missing-dvh/top and keyboard/bottom screenshots. No claim of ColorOS13.1/Reno6 or actual unknown WebView coverage: real OS font scaling, actual IME and old engine remain untested. True legacy verification requires the device WebView version/compatible kernel; no large image was installed.
