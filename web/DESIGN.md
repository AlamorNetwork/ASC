# ASC web design

ASC is a Persian research workspace. Its main action is talking to the mother agent; the case list and dossier support that conversation. The interface must show actual research state and evidence without implying that queued agents are running or that a matching quote proves a historical claim.

## Visual direction

- Dark, Slytherin-inspired research archive. Use near-black green surfaces (`#050907`, `#080e0a`, `#0c1510`) instead of neutral gray panels.
- Emerald (`#77caa0`) marks interactive paths and active work. Antique gold (`#cfad69`) marks navigation, document context, and evidence. Red is reserved for failure. Do not introduce rainbow status colors or gradient-heavy AI styling.
- Vazirmatn is the Persian UI font; Georgia is reserved for small Latin labels and numerals. Main reading text starts at 14px with generous line height.
- Keep borders quiet, hierarchy clear, corners modest, and the existing atlas artwork subdued. Surface tints carry depth; decoration must not compete with source text.

## Product layout

- Four workspace pages: mother-agent conversation, an owner-wide source library, a research-agent tree, and evidence review. The conversation retains its dossier inspector for in-context work.
- The source library lists documents across all of the owner's dossiers, labels each origin, provides stored passages and original PDF preview/download only when the original is actually on disk. Its Markdown export is generated from the database.
- The agent tree uses a restrained storm/cloud treatment. Every status label comes from a saved research node; pending agents must never appear active.
- Mobile: each page fills the viewport. Cases and the chat dossier open as drawers over a backdrop; they never stack underneath the page and create an empty tail.
- Preserve every existing form, route, element ID, server action, and cost confirmation. The proposed full-access/cost-control UI remains deferred until its own design is agreed.

## Interaction contract

- Visible focus, keyboard-accessible tabs, Escape and backdrop to close mobile drawers, 42–44px mobile touch targets, and reduced-motion support.
- Real empty, loading, error, disabled, running, paused, and completed states must remain distinguishable by text as well as color.
- The UI must work at 320px through desktop widths without document-level horizontal or vertical overflow; each content region manages its own scroll.
