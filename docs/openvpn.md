# OpenVPN

OpenVPN endpoints use the same users, expiration dates, internal squads and traffic
allowances as Xray. The panel manages OpenVPN through the authenticated Remnanode
API. Each server endpoint has a persistent CA and each user receives a separate
client certificate. Rotating a user's VLESS credentials also revokes their old
OpenVPN certificate.

Use the matching [node fork](https://github.com/kehrazy/remnanode),
[panel frontend](https://github.com/kehrazy/remnawave-frontend) and
[subscription page](https://github.com/kehrazy/remnawave-subscription-page).
Their `openvpn` workflows build Linux images and publish image archives as GitHub
release assets. A Docker Hub account is unnecessary. Image tags contain the full
source commit; verify the accompanying SHA-256 file before loading an archive.

## Deployment

Back up the database, existing container configuration and node persistent data.
Deploy the new node image with OpenVPN enabled before creating an endpoint.
The node's Compose override supplies `/dev/net/tun`, `NET_ADMIN` and persistent
storage. Enable IPv4 forwarding on the host and allow the chosen public port.
Keep the existing Xray core version and configuration during the rollout.

Deploy the panel image using the existing database, Redis and environment.
Its normal startup migration adds `openvpn_endpoints` and `openvpn_user_usage`;
it does not replace users or Xray configurations. Deploy the matching subscription
page image. Remove any mounted frontend HTML from an older image: its asset names
refer to a different frontend build.

Open **Management → OpenVPN** and add a server endpoint. Select a node, public
address, port, transport and a distinct `10.x.x.0/24` tunnel subnet. Empty internal
squads grant access to all otherwise eligible accounts. A relay endpoint forwards
connections through its node to a server endpoint on another node; it uses the
exit server's certificates and transport. Relay chains are rejected.

Each eligible user's existing subscription page displays downloadable `.ovpn`
profiles. Import them into an OpenVPN client. Xray subscription formats and
existing VLESS links remain usable. OpenVPN downloads are separate files because
Xray and sing-box subscriptions cannot represent OpenVPN connections.

The supported control-channel settings are `tls-crypt-v2`, `tls-crypt`, `tls-auth`
and `none`. `none` retains certificate-based TLS and authenticated data encryption;
it omits the additional pre-shared control-channel wrapper. Compression is disabled
in every mode. These are configuration choices, not promises of DPI resistance.
Test both the handshake and sustained data transfer on the affected ISP.

## Access and accounting

The panel reconciles accounts and cumulative counters every 15 seconds and on user
or node events. The node independently checks expiration every five seconds and
disconnects sessions that no longer have access. Persist the entire OpenVPN state
directory, including its CA, client keys and counters. Repeated downloads and
container restarts retain the same credentials.

OpenVPN traffic contributes to the existing user allowance, lifetime totals and
node usage history. Database transactions deduplicate cumulative counters by node
and counter epoch. Accounting occurs at the OpenVPN server, including when a relay
forwards the connection. A relay does not independently account encrypted packets.

OpenVPN cannot enforce Happ's device binding. Accounts subject to the existing HWID
policy therefore receive no OpenVPN profiles. Expired, disabled, over-quota and
out-of-squad accounts cannot download or authenticate with a profile.

## API

Authenticated administration endpoints:

| Method | Path                           | Purpose                                      |
| ------ | ------------------------------ | -------------------------------------------- |
| GET    | `/api/openvpn/endpoints`       | List endpoints and last observed node health |
| POST   | `/api/openvpn/endpoints`       | Create an endpoint                           |
| PATCH  | `/api/openvpn/endpoints/:uuid` | Edit or disable an endpoint                  |
| DELETE | `/api/openvpn/endpoints/:uuid` | Stop and remove an endpoint                  |
| POST   | `/api/openvpn/endpoints/sync`  | Reconcile accounts and collect usage         |

API tokens require `openvpn:*` or `*`. User downloads use the existing secret
subscription identifier at `/api/openvpn/subscriptions/:shortUuid/:uuid.ovpn`.
The subscription page proxies downloads through its existing hostname.

## Rollback

Restore the previous image references and restart the affected services. Keep the
additive database tables and OpenVPN persistent data: the previous panel ignores
them, and retaining them allows a later retry without reissuing credentials.
Removing an endpoint stops it but retains its PKI files. Disable endpoints before
removing OpenVPN support; remove only their owned `RWOVP...` firewall chains.
