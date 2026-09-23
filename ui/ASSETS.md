# Cinematic scenes

The landing page uses illustrative generated imagery, not customer installations
or measured model output. These three new assets were made with the built-in
Image Gen tool on 23 September 2026. Original PNGs remain in the operator's
generated-images directory. Project assets live in `public/images/world/` as
1200px and 600px WebP variants, encoded at quality 83 with `cwebp`.

Production prompt set:

- **world.webp / world-600.webp:** Wide 3:2 high-end scientific editorial
  photograph of an autonomous mobile robot in an industrial research warehouse.
  Floor-height camera along a long aisle, one realistic wheeled rover, precise
  shelving and concrete floor. Sparse white-blue LiDAR reconstruction points and
  a fine trajectory integrated into the scene. Deep navy shadows, cold steel,
  restrained blue laboratory light, realistic materials, optical depth and quiet
  edges. No text, UI, logos, borders, neon, fantasy holograms or cartoon treatment.
- **bci.webp / bci-600.webp:** Wide 3:2 refined editorial macro photograph of a
  non-invasive EEG electrode cap on a matte neutral head-form in an empty
  neuroscience laboratory. Real fabric mesh, small silver electrodes, thin
  routed cables and softly blurred amplifier hardware. Navy shadows, steel
  highlights, restrained blue light and quiet edges. No person, surgery,
  implants, text, logos, UI, floating brain, neon or diagnostic claims.
- **quantum.webp / quantum-600.webp:** Wide 3:2 high-end editorial photograph of
  a dilution refrigerator interior: nested gold/copper thermal plates, orderly
  silver coaxial lines, bolted flanges and cryogenic hardware. Intricate physical
  detail, restrained gold highlights against navy shadows and steel blue ambient
  light, quiet edges. No text, logos, UI, glowing atoms, neon or fantasy holograms.

`CinematicScene.tsx` supplies a bounded 4.8-second camera move and scan reveal.
Motion pauses when offscreen, when the document is hidden, or through the visible
pause control. Replay is explicit; reduced-motion preferences produce a static
image. Only the selected model's scene is mounted and images load lazily.
`HistorySequence` lets visitors expand a recorded moment without a database call.
The existing robot timeline, Jev banner and native keyboard controls remain.
