import crypto from "crypto";
import ivm from "isolated-vm";

const SHIM = String.raw`
const KEY_ID = Symbol('keyId');

const keyRegistry = new FinalizationRegistry((keyId) => {
  try {
    $10.applyIgnored(undefined, [keyId]);
  } catch {}
});

class CryptoKey {
  constructor(meta) {
    this[KEY_ID] = meta.keyId;
    this.type = meta.type;
    this.extractable = meta.extractable;
    this.algorithm = meta.algorithm;
    this.usages = meta.usages;

    keyRegistry.register(this, meta.keyId);
  }
}

globalThis.CryptoKey = CryptoKey;

function extractKeyId(key) {
  if (!key || !key[KEY_ID]) {
    throw new TypeError('Expected an instance of CryptoKey');
  }
  return key[KEY_ID];
}

function toArrayBuffer(data, functionName) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  throw new TypeError("Failed to execute '" + functionName + "' on 'SubtleCrypto': The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.");
}

globalThis.crypto = {
  randomUUID: () => {
    return $0.applySync(undefined, [], { result: { copy: true } });
  },

  getRandomValues: (typedArray) => {
    if (!ArrayBuffer.isView(typedArray)) {
      throw new TypeError('Expected ArrayBufferView');
    }
    const bytes = $1.applySync(undefined, [typedArray.byteLength], {
      result: { copy: true }
    });
    new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength).set(bytes);
    return typedArray;
  },

  subtle: {
    digest: async (algorithm, data) => {
      const buffer = toArrayBuffer(data, 'digest');
      return await $2.apply(undefined, [algorithm, buffer], {
        arguments: { copy: true },
        result: { promise: true, copy: true }
      });
    },

    generateKey: async (algorithm, extractable, keyUsages) => {
      const res = await $3.apply(undefined, [algorithm, extractable, keyUsages], {
        arguments: { copy: true },
        result: { promise: true, copy: true }
      });
      if (res.isPair) {
        return {
          publicKey: new CryptoKey(res.publicKey),
          privateKey: new CryptoKey(res.privateKey)
        };
      }
      return new CryptoKey(res.key);
    },

    encrypt: async (algorithm, key, data) => {
      const keyId = extractKeyId(key);
      const buffer = toArrayBuffer(data, 'encrypt');
      return await $4.apply(undefined, [algorithm, keyId, buffer], {
        arguments: { copy: true },
        result: { promise: true, copy: true }
      });
    },

    decrypt: async (algorithm, key, data) => {
      const keyId = extractKeyId(key);
      const buffer = toArrayBuffer(data, 'decrypt');
      return await $5.apply(undefined, [algorithm, keyId, buffer], {
        arguments: { copy: true },
        result: { promise: true, copy: true }
      });
    },

    sign: async (algorithm, key, data) => {
      const keyId = extractKeyId(key);
      const buffer = toArrayBuffer(data, 'sign');
      return await $6.apply(undefined, [algorithm, keyId, buffer], {
        arguments: { copy: true },
        result: { promise: true, copy: true }
      });
    },

    verify: async (algorithm, key, signature, data) => {
      const keyId = extractKeyId(key);
      const signBuffer = toArrayBuffer(signature, 'verify');
      const dataBuffer = toArrayBuffer(data, 'verify');
      return await $7.apply(undefined, [algorithm, keyId, signBuffer, dataBuffer], {
        arguments: { copy: true },
        result: { promise: true, copy: true }
      });
    },

    importKey: async (format, keyData, algorithm, extractable, keyUsages) => {
      const payload = format === 'jwk' ? keyData : toArrayBuffer(keyData, 'importKey');
      const meta = await $8.apply(undefined, [format, payload, algorithm, extractable, keyUsages], {
        arguments: { copy: true },
        result: { promise: true, copy: true }
      });
      return new CryptoKey(meta);
    },

    exportKey: async (format, key) => {
      const keyId = extractKeyId(key);
      return await $9.apply(undefined, [format, keyId], {
        arguments: { copy: true },
        result: { promise: true, copy: true }
      });
    }
  }
};
`;

type CryptoKey = crypto.webcrypto.CryptoKey;
type AlgorithmIdentifier = crypto.webcrypto.AlgorithmIdentifier;
type RsaOaepParams = crypto.webcrypto.RsaOaepParams;
type AesCtrParams = crypto.webcrypto.AesCtrParams;
type AesCbcParams = crypto.webcrypto.AesCbcParams;
type AeadParams = crypto.webcrypto.AeadParams;
type RsaPssParams = crypto.webcrypto.RsaPssParams;
type EcdsaParams = crypto.webcrypto.EcdsaParams;
type ContextParams = crypto.webcrypto.ContextParams;
type KmacParams = crypto.webcrypto.KmacParams;
type RsaHashedImportParams = crypto.webcrypto.RsaHashedImportParams;
type EcKeyImportParams = crypto.webcrypto.EcKeyImportParams;
type HmacImportParams = crypto.webcrypto.HmacImportParams;
type AesKeyAlgorithm = crypto.webcrypto.AesKeyAlgorithm;
type KmacImportParams = crypto.webcrypto.KmacImportParams;
type CShakeParams = crypto.webcrypto.CShakeParams;
type TurboShakeParams = crypto.webcrypto.TurboShakeParams;
type KangarooTwelveParams = crypto.webcrypto.KangarooTwelveParams;

export default async function inject(context: ivm.Context) {
  const keyStore = new Map<string, CryptoKey>();

  function getRandomValues(byteLength: number) {
    return new Uint8Array(crypto.randomBytes(byteLength));
  }

  function registerSingleKey(key: CryptoKey) {
    const keyId = crypto.randomUUID();
    keyStore.set(keyId, key);
    return {
      keyId,
      type: key.type,
      extractable: key.extractable,
      algorithm: key.algorithm,
      usages: key.usages
    };
  }

  async function generateKey(algorithm: AlgorithmIdentifier | RsaOaepParams | AesCtrParams | AesCbcParams | AeadParams, extractable: boolean, keyUsages: KeyUsage[]) {
    const generated = await crypto.subtle.generateKey(algorithm, extractable, keyUsages);
    if ('publicKey' in generated && 'privateKey' in generated) {
      return {
        isPair: true,
        publicKey: registerSingleKey(generated.publicKey),
        privateKey: registerSingleKey(generated.privateKey)
      };
    }
    return {
      isPair: false,
      key: registerSingleKey(generated)
    };
  }

  async function encrypt(algorithm: AlgorithmIdentifier | RsaOaepParams | AesCtrParams | AesCbcParams | AeadParams, keyId: string, data: ArrayBuffer) {
    const realKey = keyStore.get(keyId);
    if (!realKey) throw new Error(`CryptoKey [${keyId}] not found in host registry.`);
    return await crypto.subtle.encrypt(algorithm, realKey, data);
  }

  async function decrypt(algorithm: AlgorithmIdentifier | RsaOaepParams | AesCtrParams | AesCbcParams | AeadParams, keyId: string, data: ArrayBuffer) {
    const realKey = keyStore.get(keyId);
    if (!realKey) throw new Error(`CryptoKey [${keyId}] not found in host registry.`);
    return await crypto.subtle.decrypt(algorithm, realKey, data);
  }

  async function sign(algorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams | ContextParams | KmacParams, keyId: string, data: ArrayBuffer) {
    const realKey = keyStore.get(keyId);
    if (!realKey) throw new Error(`CryptoKey [${keyId}] not found in host registry.`);
    return await crypto.subtle.sign(algorithm, realKey, data);
  }

  async function verify(algorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams | ContextParams | KmacParams, keyId: string, signature: ArrayBuffer, data: ArrayBuffer) {
    const realKey = keyStore.get(keyId);
    if (!realKey) throw new Error(`CryptoKey [${keyId}] not found in host registry.`);
    return await crypto.subtle.verify(algorithm, realKey, signature, data);
  }

  async function importKey(
    format: KeyFormat,
    keyData: ArrayBuffer | JsonWebKey,
    algorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams | HmacImportParams | AesKeyAlgorithm | KmacImportParams,
    extractable: boolean,
    keyUsages: KeyUsage[]
  ) {
    const realKey = await crypto.subtle.importKey(
      format as "pkcs8",
      keyData as ArrayBuffer,
      algorithm,
      extractable,
      keyUsages
    );
    return registerSingleKey(realKey);
  }

  async function exportKey(format: KeyFormat, keyId: string) {
    const realKey = keyStore.get(keyId);
    if (!realKey) throw new Error(`CryptoKey [${keyId}] not found in host registry.`);
    return await crypto.subtle.exportKey(format, realKey);
  }

  await context.evalClosure(
    SHIM,
    [
      () => crypto.randomUUID(),
      getRandomValues,
      (algo: AlgorithmIdentifier | CShakeParams | TurboShakeParams | KangarooTwelveParams, data: ArrayBuffer) => crypto.subtle.digest(algo, data),
      generateKey,
      encrypt,
      decrypt,
      sign,
      verify,
      importKey,
      exportKey,
      (keyId: string) => keyStore.delete(keyId)
    ].map(fn => new ivm.Reference(fn)),
    {
      filename: `crypto.js`,
    }
  );

  return { keyStore };
}