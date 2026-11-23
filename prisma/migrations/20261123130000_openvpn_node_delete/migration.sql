ALTER TABLE "openvpn_endpoints" DROP CONSTRAINT "openvpn_endpoints_node_uuid_fkey";
ALTER TABLE "openvpn_endpoints" ADD CONSTRAINT "openvpn_endpoints_node_uuid_fkey"
    FOREIGN KEY ("node_uuid") REFERENCES "nodes"("uuid") ON DELETE RESTRICT ON UPDATE CASCADE;
