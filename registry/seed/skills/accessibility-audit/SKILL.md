---
name: accessibility-audit
description: Audit a web page or UI component for WCAG 2.2 AA issues and propose fixes. Use when building or reviewing user interface code, or when asked about accessibility.
license: MIT
metadata:
  category: accessibility
  tags: a11y wcag aria contrast keyboard screen-reader
---

# Accessibility audit

Check UI code against WCAG 2.2 AA and report problems with concrete fixes.

## Checklist

Work through the component or page in this order; most real-world issues show up in the
first four.

1. **Keyboard.** Every interactive element is reachable with Tab, operable with Enter or
   Space, and has a visible focus indicator. No keyboard traps. Focus order follows reading
   order. Custom widgets follow the ARIA Authoring Practices pattern for their role.
2. **Names and roles.** Buttons and links have an accessible name. Icon-only buttons have an
   `aria-label`. Use native elements (`button`, `a`, `input`) before ARIA roles.
3. **Forms.** Every input has a programmatic label. Errors are announced, tied to the field
   with `aria-describedby`, and do not rely on color alone.
4. **Contrast.** Text has 4.5:1 contrast (3:1 for large text and UI component boundaries).
   Check hover, focus, disabled and dark-mode states too.
5. **Structure.** One `h1`, headings in order, landmarks (`header`, `nav`, `main`, `footer`),
   and a skip link on pages with repeated navigation.
6. **Images and media.** Informative images have meaningful `alt`; decorative ones use
   `alt=""`. Video has captions.
7. **Motion and time.** Animations respect `prefers-reduced-motion`. Nothing flashes more than
   three times per second. Time limits can be extended.
8. **Zoom and reflow.** Content works at 200% zoom and at 320 CSS pixels wide without
   horizontal scrolling.

## Reporting

For each issue give: the element (file and line, or selector), the WCAG success criterion,
who is affected, and the smallest code change that fixes it. Order by impact. Automated
checkers find only part of these issues; say which items you verified by reading code and
which need a manual test with a screen reader.
