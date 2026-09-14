import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

/// Licence keys, generated the same way the rest of QServe reads them.
///
/// A third copy of `packages/shared/src/license-key.ts` — the application has
/// one, the web console has one, and this is the one that runs on the vendor's
/// phone. `npm run validate:supabase` already proves the web copy against the
/// original; the test beside this file does the same for this one. A key issued
/// here that a restaurant's checksum rejects is a key somebody has paid for.
///
/// Crockford's base 32: no I, L, O or U. A customer reading a key down the
/// phone cannot turn a 1 into an I, and cannot accidentally spell anything.
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const bodyLength = 19;

/// Weighted by position, so transposing two characters changes the sum. An
/// unweighted sum would not notice, and transposition is the mistake people
/// actually make when copying a key by hand.
String checksumChar(String body) {
  var sum = 0;
  for (var i = 0; i < body.length; i += 1) {
    sum += alphabet.indexOf(body[i]) * (i + 2);
  }
  return alphabet[sum % 32];
}

String generateLicenceKey([Random? source]) {
  final random = source ?? Random.secure();
  final body = StringBuffer();
  for (var i = 0; i < bodyLength; i += 1) {
    body.write(alphabet[random.nextInt(256) % 32]);
  }
  final full = '$body${checksumChar(body.toString())}';

  final groups = <String>[];
  for (var i = 0; i < full.length; i += 5) {
    groups.add(full.substring(i, min(i + 5, full.length)));
  }
  return ['QSRV', ...groups].join('-');
}

/// What the database stores beside the key: its hash, so an activation can be
/// checked without the database being a list of keys.
String sha256Hex(String text) => sha256.convert(utf8.encode(text)).toString();

/// The last five characters, which is what a vendor reads out to confirm they
/// are talking about the same licence.
String keyHint(String key) {
  final bare = key.replaceAll('-', '');
  return bare.length <= 5 ? bare : bare.substring(bare.length - 5);
}
