// Minimal Jito bundle submit via gRPC using @grpc/grpc-js
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import path from "node:path";
import { getGrpcEndpoint } from "./rpc.js";
import { VersionedTransaction } from "@solana/web3.js";

let jitoClient = null;

function loadProto() {
  const packageDefinition = protoLoader.loadSync(
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../protos/bundle.proto"
    ),
    {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    }
  );
  const descriptor = grpc.loadPackageDefinition(packageDefinition);
  return descriptor.jito;
}

export function getJitoClient() {
  if (jitoClient) return jitoClient;
  const endpoint = getGrpcEndpoint();
  if (!endpoint) return null;
  const proto = loadProto();
  jitoClient = new proto.bundle.BundleService(
    endpoint,
    grpc.credentials.createInsecure()
  );
  return jitoClient;
}

export async function submitBundle(base64Transactions = []) {
  const client = getJitoClient();
  if (!client) throw new Error("gRPC endpoint not configured");
  return new Promise((resolve, reject) => {
    client.SubmitBundle({ transactions: base64Transactions }, (err, resp) => {
      if (err) return reject(err);
      resolve(resp);
    });
  });
}

export function serializeToBase64(tx) {
  const bytes = tx.serialize();
  return Buffer.from(bytes).toString("base64");
}
