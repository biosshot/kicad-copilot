export function pcbTemplate(major: 9 | 10) {
    const version = major === 10 ? '20260206' : '20241229';
    const layers = major === 10 ? `
    (0 "F.Cu" signal)
    (2 "B.Cu" signal)
    (9 "F.Adhes" user "F.Adhesive")
    (11 "B.Adhes" user "B.Adhesive")
    (13 "F.Paste" user)
    (15 "B.Paste" user)
    (5 "F.SilkS" user "F.Silkscreen")
    (7 "B.SilkS" user "B.Silkscreen")
    (1 "F.Mask" user)
    (3 "B.Mask" user)
    (17 "Dwgs.User" user "User.Drawings")
    (19 "Cmts.User" user "User.Comments")
    (21 "Eco1.User" user "User.Eco1")
    (23 "Eco2.User" user "User.Eco2")
    (25 "Edge.Cuts" user)
    (27 "Margin" user)
    (31 "F.CrtYd" user "F.Courtyard")
    (29 "B.CrtYd" user "B.Courtyard")
    (35 "F.Fab" user)
    (33 "B.Fab" user)` : `
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (36 "B.SilkS" user "b.silkscreen")
    (37 "F.SilkS" user "f.silkscreen")
    (44 "Edge.Cuts" user)
    (46 "B.CrtYd" user "b.courtyard")
    (47 "F.CrtYd" user "f.courtyard")
    (48 "B.Fab" user)
    (49 "F.Fab" user)`;
    return `(kicad_pcb
  (version ${version})
  (generator "kicad-copilot")
  (generator_version "${major}.0")
  (general (thickness 1.6))
  (paper "A4")
  (layers${layers}
  )
  (setup (pad_to_mask_clearance 0))
)
`;
}
