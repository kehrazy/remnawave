# VPN engines

Xray, OpenVPN and AmneziaWG use the panel's configuration profiles, node assignments,
Hosts, internal squads and user accounts. OpenVPN and AmneziaWG do not have separate
endpoint administration APIs.

A configuration profile selects one `engine`: `xray`, `openvpn` or `amneziawg`.
Its listeners are assigned in **Nodes**. A **Host** publishes a listener's address,
port and display name. Internal squads grant users access to listeners; Host squad
rules can further restrict a published route. A native VPN Host belongs to one
assigned node, because that node owns the server's keys.

Nodes can run any combination of these engines, including OpenVPN or AmneziaWG
without Xray. Agent connectivity, per-engine state and per-listener errors are
reported separately. Restarting one engine leaves other engines running. Disabling
a node stops its assigned VPN services and suppresses dependent relay routes.

## Create a route

1. In **Profiles**, create an OpenVPN or AmneziaWG profile and configure a server
   listener with an unused port and a distinct `10.x.x.0/24` tunnel pool.
2. In **Nodes**, assign the listener to its server.
3. In **Hosts**, select that listener and node, then set the client-facing address,
   port and name.
4. Add the listener to the internal squads whose users should have access.

For a relay, create a listener with `mode: "relay"`, a tag, a local port and
`relayTargetUuid` pointing to the exit server's Host. Assign it to another node,
create its public Host and grant access through squads. The relay inherits tunnel
and encryption settings from the exit. It forwards traffic without terminating
the VPN. Relay chains and targets on the same node are rejected.

Listener tags are unique across profiles. Existing server pools and cryptographic
settings cannot be changed in place after assignment. Create another listener for
a different identity. Unassigning and reassigning an existing listener preserves
its runtime UUID, certificates and device keys. Remove relay dependencies before
deleting a server or target Host.

## Users and subscriptions

Both native engines enforce the account's status, expiry, internal-squad access
and shared traffic allowance. Usage is charged at the terminating exit, once per
cumulative-counter delta. Relays do not charge the same payload a second time.
Native profiles are unavailable when HWID enforcement requires an identifier that
the native client cannot supply.

OpenVPN uses persistent server CAs and individual user certificates. Credential
rotation revokes the previous certificate. AmneziaWG creates separate peer keys
for each account device and exit; users can manage up to five devices on their
subscription page. Each device needs its own profile.

Subscription metadata contains a typed `connectionProfiles` manifest with engine,
format, name and download URL. The installation guide chooses compatible clients:
Xray applications use existing subscriptions, OpenVPN clients import `.ovpn`, and
AmneziaWG clients import `.conf`. Existing VLESS links, subscription URLs and native
file URLs remain valid. The former native-profile metadata arrays remain available
for compatibility.

## Deployment

Use the matching [node fork](https://github.com/kehrazy/remnanode),
[frontend](https://github.com/kehrazy/remnawave-frontend) and
[subscription page](https://github.com/kehrazy/remnawave-subscription-page).
The `openvpn` workflows publish image archives and SHA-256 checksums on GitHub
Releases; a Docker Hub account is unnecessary. Frontend and subscription builds
install a contract archive pinned to a tested backend commit. Panel builds pin a
specific frontend release.

The node setup wizard supplies an image download command and Compose configuration.
Native services require `/dev/net/tun`, `NET_ADMIN`, host forwarding and persistent
OpenVPN and AmneziaWG state directories. On a multi-address server, set
`AMNEZIAWG_BIND_ADDRESS` to the ingress IPv4. The listener's optional egress address
controls internet traffic separately. Preserve the existing Xray binary and
configuration during a management-plane upgrade.

Back up PostgreSQL, container configuration and every node's persistent keys before
migration. Upgrade agents before the panel. The normal panel entrypoint runs Prisma
migrations; deployments overriding that entrypoint must run `prisma migrate deploy`
explicitly before starting the new backend.

The native-profile migration retains old endpoint tables as rollback data. Runtime
UUIDs and public Host UUIDs retain the original endpoint UUIDs. No active management
code reads the legacy tables. `prisma/rollback-native-vpn.sql` supports an immediate
deployment rollback: stop the new panel, back up its database, apply the SQL and
restore the previous panel. Keep new agents running while the old panel restores
its endpoint definitions. Legacy tables are not synchronized with later profile
edits, so this SQL is not a general undo for subsequent administration changes.

OpenVPN supports `none`, `tls-auth`, `tls-crypt` and `tls-crypt-v2` control-channel
wrappers and optional UDP handshake masking. `none` retains certificate-based TLS
and authenticated data encryption. AmneziaWG supports generations 2.0 and 3.1 with
validated parameter overrides. These settings do not guarantee continued access
through any particular censor or network.
