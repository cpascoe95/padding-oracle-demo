import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';


async function crack(ciphertext: Buffer, blocksizeBytes: number, paddingOracle: (ciphertext: Buffer) => Promise<boolean>): Promise<Buffer> {
  if (ciphertext.length === 0 || ciphertext.length % blocksizeBytes !== 0) {
    throw new Error('Invalid ciphertext');
  }

  const allButLastTwoBlocks = ciphertext.slice(
    0,
    ciphertext.length - blocksizeBytes * 2
  );

  const secondToLastBlock = ciphertext.slice(
    ciphertext.length - blocksizeBytes * 2,
    ciphertext.length - blocksizeBytes
  );

  const lastBlock = ciphertext.slice(ciphertext.length - blocksizeBytes);

  const decryptedLastBlock: number[] = [];

  for (let offset = blocksizeBytes - 1; offset >= 0; offset--) {
    const paddingValue = blocksizeBytes - offset;

    const testCiphertext = Buffer.concat([
      allButLastTwoBlocks,
      secondToLastBlock.slice(0, offset),
      Buffer.from([0]), // The current target value that we're going to change
      // XOR with each decrypted byte so that the next decryption byte results in 0, then XOR with desired padding value
      Buffer.from(decryptedLastBlock.map((bte, i) => secondToLastBlock[i + offset + 1] ^ bte ^ paddingValue)),
      lastBlock
    ]);

    const testIndex = allButLastTwoBlocks.length + offset;
    const originalValue = secondToLastBlock[offset];

    let found = false;
    // Zero should always decrypt as expected
    for (let test = 1; test < 256; test++) {
      testCiphertext[testIndex] = originalValue ^ test;

      if (await paddingOracle(testCiphertext)) {
        if (offset === blocksizeBytes - 1) {
          // Need to check for coincidental padding
          // (e.g. second-to-last byte is 0x02, and
          // we've just set the last byte to 0x02
          // instead of 0x01 as we were expecting)

          // Just flip a bit to see if it affects the result
          testCiphertext[testIndex - 1] ^= 1;
          const res = await paddingOracle(testCiphertext);
          // Revert the change
          testCiphertext[testIndex - 1] ^= 1;

          if (!res) {
            // We've found a coincidental padding value - continue instead
            continue;
          }
        }

        decryptedLastBlock.unshift(test ^ paddingValue);
        found = true;
        break;
      }
    }

    if (!found) {
      // This occurs when we hit the last padding byte of the decrypted data
      decryptedLastBlock.unshift(paddingValue);
    }
  }

  if (allButLastTwoBlocks.length >= blocksizeBytes) {
    const preceedingBytes = await crack(Buffer.concat([allButLastTwoBlocks, secondToLastBlock]), blocksizeBytes, paddingOracle);

    return Buffer.concat([preceedingBytes, Buffer.from(decryptedLastBlock)]);
  } else {
    return Buffer.from(decryptedLastBlock);
  }
}


function addPadding(data: Buffer, blocksize: number): Buffer {
  const diff = blocksize - (data.length % blocksize);

  const padding: number[] = [];

  for (let i = 0; i < diff; i++) {
    padding.push(diff);
  }

  return Buffer.concat([data, Buffer.from(padding)]);
}


function removePadding(data: Buffer): Buffer {
  const paddingLength = data[data.length - 1];

  for (let i = data.length - 1; i >= data.length - paddingLength; i--) {
    if (data[i] !== paddingLength) {
      throw new Error('Invalid padding');
    }
  }

  return data.slice(0, data.length - paddingLength);
}


async function computeIv(firstCiphertextBlock: Buffer, firstPlaintextBlock: Buffer, paddingOracle: (ciphertext: Buffer) => Promise<boolean>): Promise<Buffer> {
  const blockSize = firstCiphertextBlock.length;

  const decryptedIV: number[] = [];
  const mockIv: Buffer = Buffer.alloc(blockSize);

  for (let offset = blockSize - 1; offset >= 0; offset--) {
    const paddingValue = blockSize - offset;

    const testCiphertext = Buffer.concat([
      mockIv.slice(0, offset),
      Buffer.from([0]), // The current target value that we're going to change
      // XOR with each decrypted byte so that the next decryption byte results in 0, then XOR with desired padding value
      // We know the plaintext block, essentially trying to figure out the previous block (reverse of `crack`)
      Buffer.from(decryptedIV.map((bte, i) => firstPlaintextBlock[i + offset + 1] ^ bte ^ paddingValue)),
      firstCiphertextBlock
    ]);

    const testIndex = offset;
    const plaintextValue = firstPlaintextBlock[offset];

    let found = false;
    // Zero should always decrypt as expected
    for (let test = 1; test < 256; test++) {
      testCiphertext[testIndex] = plaintextValue ^ test;

      if (await paddingOracle(testCiphertext)) {
        if (offset === blockSize - 1) {
          // Need to check for coincidental padding
          // (e.g. second-to-last byte is 0x02, and
          // we've just set the last byte to 0x02
          // instead of 0x01 as we were expecting)

          // Just flip a bit to see if it affects the result
          testCiphertext[testIndex - 1] ^= 1;
          const res = await paddingOracle(testCiphertext);
          // Revert the change
          testCiphertext[testIndex - 1] ^= 1;

          if (!res) {
            // We've found a coincidental padding value - continue instead
            continue;
          }
        }

        decryptedIV.unshift(test ^ paddingValue);
        found = true;
        break;
      }
    }

    if (!found) {
      // This occurs when we hit the last padding byte of the decrypted data
      decryptedIV.unshift(paddingValue);
    }
  }

  return Buffer.from(decryptedIV);
}


async function encrypt(plaintext: Buffer, blocksize: number, paddingOracle: (ciphertext: Buffer) => Promise<boolean>): Promise<{iv: Buffer, ciphertext: Buffer}> {
  const paddedPlaintext = addPadding(plaintext, blocksize);

  const blocks = paddedPlaintext.length / blocksize;

  let ciphertextBlock = randomBytes(blocksize);
  const ciphertext = [];

  for (let i = blocks - 1; i >= 0; i--) {
    const plaintextBlock = paddedPlaintext.slice(i * blocksize, (i + 1) * blocksize);

    const prevCiphertextBlock = await computeIv(ciphertextBlock, plaintextBlock, paddingOracle);

    ciphertext.unshift(ciphertextBlock);
    ciphertextBlock = prevCiphertextBlock;
  }

  return {
    iv: ciphertextBlock,
    ciphertext: Buffer.concat(ciphertext)
  };
}


function aes256CbcEncrypt(key: Buffer, iv: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-cbc', key, iv);

  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}


function aes256CbcDecrypt(key: Buffer, iv: Buffer, ciphertext: Buffer): Buffer {
  const cipher = createDecipheriv('aes-256-cbc', key, iv);

  return Buffer.concat([cipher.update(ciphertext), cipher.final()]);
}


(async function demo() {
  const plaintext = Buffer.from('The quick brown fox jumped over the lazy dog. This is a sample message to decrypt.');
  const key = randomBytes(32);
  const iv = randomBytes(16);

  const ciphertext = aes256CbcEncrypt(key, iv, plaintext);

  // Async, because padding oracle implementation could be via a network request
  const paddingOracle = async (testCiphertext: Buffer): Promise<boolean> => {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);

    decipher.update(testCiphertext);

    try {
      decipher.final();
      return true;
    } catch (err) {
      return false;
    }
  };


  console.log('Cracking a Message without IV:');
  const decrypted = await crack(ciphertext, 16, paddingOracle);
  console.log('  Plaintext: ' + plaintext.toString());
  console.log('  Decrypted: ' + ' '.repeat(16) + removePadding(decrypted).toString());
  console.log('');


  console.log('Computing IV from known Ciphertext/Plaintext first block')

  const plaintext2 = Buffer.from('This is some other plaintext where the attacker knows the first plaintext block.');
  const ciphertext2 = aes256CbcEncrypt(key, iv, plaintext2);
  const computedIv = await computeIv(ciphertext2.slice(0, 16), plaintext2.slice(0, 16), paddingOracle);

  console.log('  Original IV: ' + iv.toString('hex'));
  console.log('  Computed IV: ' + computedIv.toString('hex'));
  console.log('');


  console.log('Cracking a Message with IV:');

  const decryptedWithIv = await crack(Buffer.concat([computedIv, ciphertext]), 16, paddingOracle);

  console.log('  Plaintext:           ' + plaintext.toString());
  console.log('  Decrypted (with IV): ' + decryptedWithIv.toString());
  console.log('');

  await paddingCollisionCheck();

  console.log('Encrypting Arbitrary Data (with chosen IV)');

  const plaintext3 = Buffer.from('This is a plaintext that an attacker has chosen. They do not need the key to encrypt it.');
  const { iv: iv3, ciphertext: ciphertext3 } = await encrypt(plaintext3, 16, paddingOracle);
  const decryptedPlaintext3 = aes256CbcDecrypt(key, iv3, ciphertext3);

  console.log(`  Chosen plaintext:    ${plaintext3.toString()}`);
  console.log(`  Decrypted plaintext: ${decryptedPlaintext3.toString()}`);
  console.log('');

})().catch(err => console.error(err));


async function paddingCollisionCheck() {
  // This will get padded to have 0x01 at the end
  const plaintext = Buffer.from([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const key = randomBytes(32);
  const iv = randomBytes(16);

  const ciphertext = aes256CbcEncrypt(key, iv, plaintext);

  const paddingOracle = async (testCiphertext: Buffer): Promise<boolean> => {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);

    decipher.update(testCiphertext);

    try {
      decipher.final();
      return true;
    } catch (err) {
      return false;
    }
  };

  const cracked = await crack(Buffer.concat([iv, ciphertext]), 16, paddingOracle);

  if (!plaintext.equals(removePadding(cracked))) {
    throw new Error('Padding collision not working!');
  }
}
