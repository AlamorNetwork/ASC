# ASC web design

ASC is a Persian research workspace. Its main action is talking to the mother agent; the case list and dossier support that conversation. The interface must show actual research state and evidence without implying that queued agents are running or that a matching quote proves a historical claim.

## Visual direction

- Dark, Slytherin-inspired research archive. Use near-black green surfaces (`#050907`, `#080e0a`, `#0c1510`) instead of neutral gray panels.
- Emerald (`#77caa0`) marks interactive paths and active work. Antique gold (`#cfad69`) marks navigation, document context, and evidence. Red is reserved for failure. Do not introduce rainbow status colors or gradient-heavy AI styling.
- Vazirmatn is the Persian UI font; Georgia is reserved for small Latin labels and numerals. Main reading text starts at 14px with generous line height.
- Keep borders quiet, hierarchy clear, corners modest, and the existing atlas artwork subdued. Surface tints carry depth; decoration must not compete with source text.

## Product layout

- Desktop: cases on the right, conversation in the center, dossier on the left. The conversation owns the main reading width.
- The dossier has three views: live follow-up, sources/documents, and evidence. Switching views does not destroy or reload research state.
- Mobile: conversation fills the viewport. Cases and dossier open as drawers over a backdrop; they never stack underneath the chat and create an empty page tail.
- Preserve every existing form, route, element ID, server action, and cost confirmation. The proposed full-access/cost-control UI remains deferred until its own design is agreed.

## Interaction contract

- Visible focus, keyboard-accessible tabs, Escape and backdrop to close mobile drawers, 42–44px mobile touch targets, and reduced-motion support.
- Real empty, loading, error, disabled, running, paused, and completed states must remain distinguishable by text as well as color.
- The UI must work at 320px through desktop widths without document-level horizontal or vertical overflow; each content region manages its own scroll.
