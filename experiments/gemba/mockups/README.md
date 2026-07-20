# Dallas line TV mock-ups

These are standalone, high-fidelity design prototypes for the Gemba feasibility work. They are not
yet wired to the experimental WebSocket API; their client-side demo loops use the same signal names
proposed in `SIMULATOR_CONFIGURATION.md` so the visual binding is explicit.

## Mock-ups

- `dallas-line-1-android-tv/` — Sony Google TV board for the self-contained filling-line container.
- `dallas-line-2-tizen/` — Samsung Tizen board for the packaging line's external Kepware OPC UA and
  host Modbus simulators.

Serve the folder from the `edge-console` repository root:

```powershell
py -3.14 -m http.server 15176 -d experiments/gemba/mockups
```

Then open:

- `http://127.0.0.1:15176/dallas-line-1-android-tv/`
- `http://127.0.0.1:15176/dallas-line-2-tizen/`

The mock-ups are designed at 16:9 and scale down for review. The primary target is 1920 × 1080.
Line 1 uses the **A** key or its focused button to inject a fill-pressure drift. Line 2 uses the
**J** key or its focused button to inject a packer jam. Both respect reduced-motion preferences.

## Design intent

### Line 1 — continuous flow

The Sony board is for a filling-line lead viewing from across the production floor. Its single job
is to answer: **Are we making good bottles at the planned rate, and is the filler stable?** The
animated bottle rail is the design signature; the rest of the board stays quiet and prioritizes
speed, pressure, fill volume, product conditions, and shift attainment.

### Line 2 — packaging manifest

The Samsung board is for a packaging-line lead. Its single job is to answer: **Are cases moving
cleanly, and will the current pallet/order finish without intervention?** The live pallet build is
the design signature. The visual language borrows from case labels and floor paperwork rather than
reusing Line 1's process-control treatment.

Both boards use EdgeCommons brand colors and type fallbacks, but make line-specific choices so an
operator can recognize the screen before reading its title.

## OEE calculation

`telemetry-processor/` contains the proposed Lua transforms and route fragments that derive
Availability, Performance, Quality, and OEE from raw simulator shift counters. The design is
reusable for both lines and preserves Line 2's external Kepware and host-Modbus sources.
