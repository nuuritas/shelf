# Changelog

Every change a deploy carries gets a bullet under the day it shipped, newest
entry first, written for the person running this shelf. `bun run changelog`
turns this file into `/changelog`; run it in the same commit as the edit.

## 2026-11-20

- **Library**: a chosen filter drops from its own menu with an ×, one Clear all at the end of the bar resets source, folder, label and the archived view, and the menus and search field sit on the left.
- **Library**: Save is one small pill in the top bar, left of the calendar, and saves the link you just copied; a copy without a link says so above the shelf instead of submitting an empty field.

## 2026-11-19

- **Library**: Active and archived are one View menu instead of two pills, so a phone's filter bar stays one row; the trigger names the current cut and its count, and the panel lists both.
- **Agent notes**: an artifact ships two colourways, white and dark, and the guide now asks for those two — a third "light" beside white was the same pale sheet twice, so a note's picker offers the pair the app actually uses.
- **Agent notes**: `shelf add` and the MCP tools now ask the agent to name its harness and model (`--agent "OpenCode" --model "DeepSeek v4.1 Flash"`), so an artifact credits the agent that wrote it instead of Shelf CLI; notes saved before this read as `AI agent`.
- **Library**: a shelf longer than one page no longer stops at fifty — Load more at the end doubles what is on screen in place, keeps every filter in force, and the address carries the page size so a reload returns the same list.
- **Instagram**: a saved reel, photo or carousel plays inside its card through Instagram's own player, folded until you tap the card.

## 2026-11-18

- **Instagram**: a saved reel, photo or carousel is labelled Instagram and gets its own Source cut between YouTube and Web.
- **Labels**: a card's label editor folds back five seconds after the last save, so one ticked label no longer leaves the card open.
- **YouTube**: a saved video plays in its card through the official player — portrait for a Short, widescreen for anything else — and nothing loads from YouTube until you tap play.
- **Notes**: a note's card credits its writer by name alone, then the date and its `#ref`; the model is named on the artifact itself.
- **Instagram**: a saved reel, photo or carousel reads the post's caption and account instead of the login page.

## 2026-11-17

- **Pictures**: a saved page now shows the picture it came with.
- **Appearance**: the theme and text size save as soon as you pick one, so they no longer wait for Save settings.
- **Filters**: source, folder and label are three menus that show what is picked, keep several picks and close on an outside tap; a picked filter is an × you can drop on its own.
- **Changelog**: `/changelog` lists what each deploy carried, and Settings shows the newest three lines.
- **Languages**: summaries can be written in any language `Intl` knows, and Settings offers a picker for it.
- **Labels**: a card's labels are a tick list, so ticking one saves the set without leaving the page.
- **Source filter**: the library can show only saved pages or only agent artifacts.
- **YouTube**: a saved video keeps its own description instead of YouTube's generic tagline.
- **Calendar**: the calendar is an icon in the top bar instead of a text link in the filter row.
- **Links**: a long link prints as a short address, with the full URL still in the link.
- **Search**: a search finds a note by the page it cites, not only by its own text.
- **Notes**: a note's card shows its abstract or an excerpt, and `Open artifact ↗` opens the full document.
