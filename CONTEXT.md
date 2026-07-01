# SheetBuddy Chrome Extension

A Chrome extension that acts as a voice-driven AI companion for Google Sheets — the user asks a question or gives an instruction, SheetBuddy narrates a plan and executes it directly against the sheet.

## Language

**Grid anchor**:
The stable region of the Sheets UI that SheetBuddy's fixed-position widgets (the creature, the input bar) position themselves relative to, so they stay correctly placed as Sheets' own layout shifts (e.g. the sidebar opening or closing).
_Avoid_: grid container, anchor element

**SheetBuddy cursor**:
The animated on-screen indicator (SheetBuddy green) that shows where SheetBuddy is acting as a plan executes, moving to the target cell or range of each step. Distinct from the user's own OS/browser mouse cursor and from the SheetBuddy creature (the corner mascot) — the cursor shows *where*, the creature shows *state*.
_Avoid_: pointer, hand, mouse cursor
