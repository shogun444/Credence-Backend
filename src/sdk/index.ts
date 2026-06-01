// REST/HTTP client
export { CredenceClient } from './client.js'
export {
  CredenceConfig,
  CredenceApiError,
  TrustScore,
  BondStatus,
  Attestation,
  AttestationsResponse,
  VerificationProof,
} from './types.js'

// Internal gRPC client (Connect-RPC)
// Requires: npm install @bufbuild/protobuf @connectrpc/connect @connectrpc/connect-node
// Requires: buf generate  (populates src/sdk/grpc/gen/)
export {
  createCredenceGrpcClient,
  type CredenceGrpcClient,
  type CredenceGrpcConfig,
  createSharedSecretInterceptor,
  createRequestIdInterceptor,
  INTERNAL_TOKEN_HEADER,
} from './grpc/index.js'
