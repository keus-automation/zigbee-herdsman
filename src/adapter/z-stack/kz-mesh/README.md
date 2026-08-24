# kz-mesh — Keus mesh diagnostics (MT_UTIL 0x65–0x6A)

Self-contained module for the Keus mesh extensions to the ZNP coordinator's MT
interface. Wire contract: [`host_integration.md`](../../../../host_integration.md)
(Plan 06a).

Everything Keus-specific lives in this directory. Upstream `zigbee-herdsman`
files carry only small, commented hook points, so rebasing onto upstream means
reconciling the list below rather than a diff spread across the adapter. Every
hook is marked with a `kz-mesh hook:` comment — `grep -rn "kz-mesh hook"` finds
all of them.

## Contents

| File | What |
|---|---|
| `tstype.ts` | All `Kz*` types |
| `definition.ts` | The 6 MT command definitions, plus paging constants |
| `buffalo.ts` | Wire decoders for the 3 list types, sentinel handling, route-status names |
| `commands.ts` | Capability probe, paging logic, provisioning, purge |
| `provisioning.ts` | Interpreting a 0x66 result into a join bundle |

## Hook points in upstream files

| File | Change |
|---|---|
| `znp/parameterType.ts` | 3 enum entries (`LIST_KZ_*`) |
| `znp/buffaloZnp.ts` | Import + one `readKzListType` dispatch at the top of `read()`; 2 extra route-status names |
| `znp/definition.ts` | Import + `...KzUtilCommands` spread into `[Subsystem.UTIL]` |
| `znp/zpiObject.ts` | 3 entries added to `BufferAndListTypes` |
| `adapter/tstype.ts` | Re-export of the `Kz*` types |
| `adapter/adapter.ts` | Default `kz*` members on the base class (they throw) |
| `adapter/z-stack/adapter/zStackAdapter.ts` | `supportsKzMesh_` field, probe in `start()`, thin delegating `kz*` methods |
| `controller/controller.ts` | Public `kz*` passthroughs, and one branch in `addOfflineDevice` |

Two upstream behaviour changes are **not** in this module because they are fixes
to existing code, not additions:

- `forceRemoveDevice` used `Subsystem.ZDO` for `assocRemove`, which only exists
  under UTIL — the request threw and the caller's `catch` swallowed it, so the
  step never ran. Fixed, and on mesh firmware it now calls `kzDeviceRemove`
  (0x65) instead.
- `routingTableStatusLookup` in `buffaloZnp.ts` stopped at 3. `REPAIR` (4) and
  `LINK_FAIL` (5) are reachable on this firmware and can appear in stock ZDO
  routing reads too, so the names are merged in from `KZ_EXTRA_ROUTE_STATUS`.

## Things that must not change

**`assocRemove` (0x63) is non-destructive and has to stay that way.** The
`MAC_TRANSACTION_EXPIRED` recovery path in `zStackAdapter` pairs it with
`assocAdd` (0x64) to work around a sleepy device whose parent moved, and relies
on that round-trip being reversible. `kzDeviceRemove` (0x65) is the full purge —
it also destroys the APS link key, TCLK NV entry, bindings and routes, and
`assocAdd` restores none of that. **Never wire 0x65 into a retry path**: doing so
would unpair a device on a routine send retry.

**Sentinels are decoded to `null`, not passed through.** `lastRssi`/`avgRssi`
`0x7F`, `lastCorr` `0`, `age` `0xFF`, `lastHeardSec` `0xFFFF` and an all-`FF`
`extAddr` all mean "no measurement". `0x7F` in particular would otherwise read as
`+127 dBm`. RSSI and correlation only exist for the 32 strongest/freshest links
per device; `rxLqi`, `txCost` and `txFailureLo` are populated for every entry,
which is why consumers should grade link quality on those and treat RSSI as a
detail overlay.

**Counters wrap.** All 22 values from 0x67 are free-running `uint16`. Only
`(current - previous) mod 2^16` is meaningful. The last four — `heapFreeMin`,
`heapFragMin`, `nwkDataBufHigh`, `neighborCntHigh` — are min/max-ever watermarks
and must be read raw, never diffed.

## Tests

`test/kzMeshDiagnostics.test.ts` covers the wire layer: byte offsets for every
command, signed RSSI, sentinel decoding, multi-record paging and the variable
length relay lists.
