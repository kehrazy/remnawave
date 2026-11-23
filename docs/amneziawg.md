# AmneziaWG

This fork manages AmneziaWG server and UDP relay endpoints alongside Xray and
OpenVPN. Accounts, expiration dates, internal squads and traffic allowances are
shared. Each account has a default device and can create four additional devices
on its existing subscription page. Each device has its own key and tunnel address;
use a separate device profile on each simultaneously connected device.

Deploy matching node, panel, admin frontend and subscription-page builds. The
normal panel startup adds three tables: `amneziawg_endpoints`, `amneziawg_devices`
and `amneziawg_user_usage`. Existing users, subscription identifiers, Xray profiles
and OpenVPN PKI remain in place. Enable AmneziaWG on each participating node using
the [node guide](https://github.com/kehrazy/remnanode/blob/openvpn/docs/amneziawg.md).

In **Management → AmneziaWG**, create a server with a free UDP port and a distinct
`10.x.x.0/24` subnet on its node. Choose generation 3.1 for current clients or 2.0
for compatible older clients and routers. A relay must target a server on another
node and inherits the exit's access policy and cryptographic identity. Chains of
relays are rejected. Port and subnet checks include managed OpenVPN endpoints.

Eligible subscription pages offer `.conf` downloads and device creation/removal.
Use a current AmneziaWG or AmneziaVPN client supporting the selected generation;
ordinary WireGuard clients cannot consume these obfuscation settings. Existing
VLESS and OpenVPN installations do not need to change to keep using those protocols.
Removing a device revokes its peers. Rotating an account's VLESS credentials also
rotates all its AmneziaWG device credentials. Reconnecting after temporary access
revocation can reuse the saved profile; a credential rotation requires a new file.

## Parameters

Defaults follow current native-core constraints and maintained
[bivlked installer](https://github.com/bivlked/amneziawg-installer) presets, compared
with [AYastrebov's container](https://github.com/AYastrebov/docker-amneziawg).
Generation 3.1 uses a persistent header-protection key and content padding.
Generation 2.0 uses non-overlapping randomized header ranges. The mobile preset
reduces junk packet sizes and adds a DNS-shaped client signature. Settings and
keys are generated once and persist across restarts; they do not change every time
a profile is downloaded. MTU is 1280.

Random trailers are off by default because the native core has an open
[packet-classification failure](https://github.com/amnezia-vpn/amneziawg-go/issues/186)
with some padding/header combinations. Explicit random-trailer configurations
require equal S1–S4 values. Header protection requires each S value to be at least
12. Cookie protection and coupled handshake timers retain their defaults. Advanced
parameter overrides are validated before starting a server. Changing a published
endpoint's generation, preset, subnet or obfuscation requires another endpoint,
so already downloaded profiles retain their meaning.

These choices do not guarantee reachability on every ISP or against later
filtering. Verify a handshake and sustained content transfer from the affected
network. A reachable UDP port alone does not establish that the VPN works.

## Access, accounting and persistence

The panel reconciles every 15 seconds and on user/node changes. Nodes independently
remove expired peers every five seconds. Disabled, expired, over-quota and
out-of-squad accounts have no active peers; temporary disablement preserves keys
and assigned addresses for re-enabling. Deleted accounts/devices release addresses.
HWID-bound accounts receive no AmneziaWG access because this protocol cannot
implement Happ's hardware binding.

Counters are cumulative per node and account, with a persistent epoch. Database
transactions deduplicate updates and add them to existing user/node totals.
OpenVPN and AmneziaWG have separate counter cursors. Relays forward encrypted UDP
and do not bill it a second time. Recent handshakes indicate activity, not a precise
connection/session count. Each /24 supports up to 253 retained device assignments.

IPv4 traffic exits using NAT. Profiles capture IPv6 using a per-endpoint ULA and
`::/0`; owned IPv6 firewall rules block forwarding and access to the node until
native IPv6 egress is supported. Profiles do not let IPv6 fall outside the tunnel.
Local-LAN access outside the VPN remains a client policy.

Back up the database and the complete node state directory privately. Preserve
those volumes when rolling back images. Stopping/removing an endpoint removes
only its owned firewall rules. State keys remain available for recovery.

## API

Admin endpoints under `/api/amneziawg/endpoints` support GET, POST, PATCH and
DELETE `/:uuid`; POST `/sync` reconciles state. API tokens need `amneziawg:*` or `*`.
Downloads use the existing subscription authorization model:

- GET `/api/amneziawg/subscriptions/:shortUuid` lists eligible profiles.
- GET `/api/amneziawg/subscriptions/:shortUuid/:uuid.conf?device=default` exports one.
- GET/POST `/api/amneziawg/subscriptions/:shortUuid/devices` lists/creates devices.
- DELETE `/api/amneziawg/subscriptions/:shortUuid/devices/:uuid` revokes a device.

Device creation accepts `{ "name": "Phone" }`. Device identifiers are checked
against the subscription's account. Responses containing profiles/devices use
`Cache-Control: no-store`. The subscription website proxies these operations on
its existing hostname. Subscription URLs grant credential access and must remain
private, regardless of which protocol a user selects.
