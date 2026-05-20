import { extractGrpcFrames, grpcFrame, stripGrpcFrame, __grpcClientTestables } from '../../../../src/providers/core/runtime/grpc/grpc-client.ts';

describe('grpc-client framing', () => {
  test('grpcFrame writes 1-byte compression flag plus 4-byte big-endian payload length', () => {
    const payload = Buffer.from('hello grpc');
    const framed = grpcFrame(payload);

    expect(framed[0]).toBe(0);
    expect(framed.readUInt32BE(1)).toBe(payload.length);
    expect(framed.subarray(5).equals(payload)).toBe(true);
  });

  test('extractGrpcFrames round-trips framed payloads', () => {
    const payloadA = Buffer.from('hello');
    const payloadB = Buffer.from('world!');
    const combined = Buffer.concat([grpcFrame(payloadA), grpcFrame(payloadB)]);

    const frames = extractGrpcFrames(combined);
    expect(frames).toHaveLength(2);
    expect(frames[0].equals(payloadA)).toBe(true);
    expect(frames[1].equals(payloadB)).toBe(true);
  });

  test('stripGrpcFrame returns payload bytes for a single framed buffer', () => {
    const payload = Buffer.from('single');
    expect(stripGrpcFrame(grpcFrame(payload)).equals(payload)).toBe(true);
  });

  test('grpc headers align with WindsurfAPI csrf header contract', () => {
    const unaryHeaders = __grpcClientTestables.buildGrpcHeaders('/exa.Service/Foo', 'csrf-1', false);
    expect(unaryHeaders['x-codeium-csrf-token']).toBe('csrf-1');
    expect(unaryHeaders['x-csrf-token']).toBeUndefined();
    expect(unaryHeaders['grpc-accept-encoding']).toBeUndefined();

    const streamHeaders = __grpcClientTestables.buildGrpcHeaders('/exa.Service/Bar', 'csrf-2', true);
    expect(streamHeaders['x-codeium-csrf-token']).toBe('csrf-2');
    expect(streamHeaders['grpc-accept-encoding']).toBe('identity,gzip,deflate');
  });
});
