# Changelog

Every change a deploy carries gets a bullet under the day it shipped, newest
entry first, written for the person running this shelf. `bun run changelog`
turns this file into `/changelog`; run it in the same commit as the edit.

## 2026-11-17

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
