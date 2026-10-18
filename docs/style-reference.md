# NEO appearance reference

Use the NableU application design system as the visual reference. The theme tokens in `web/theme.css` were taken from NableU `public/styles.css` at commit `81cf3e22f158c921fec141aeafd5a8be6e25909b`, including its dark and light surfaces, text, borders, accents and semantic status colours. NEO defaults to dark rather than following the operating system.

The dark background is `#050b14`, cards are `#13263a`, elevated surfaces are `#17324d`, and the action accent is `#58b7f2`. Use Arial/Helvetica, 12px control corners, 16px cards and the established NableU focus treatment. Keep primary and secondary actions visually distinct; navigation uses the same selected-action treatment as NableU. Use semantic status colours for findings rather than inventing a separate brand palette.

The desktop background, connection window and browser companion follow the same reference. The header switch and Settings appearance control share a saved local dark/light choice. If browser storage is blocked, switching still works for that session. Theme choices do not change collector placement, network permissions or measurement behaviour.
