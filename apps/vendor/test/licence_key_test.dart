import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:qserve_vendor/data/licence_key.dart';

/// A key issued here has to be a key the restaurant accepts.
///
/// This is the third implementation of one algorithm — the application has
/// one, the web console has one, and this runs on the vendor's phone. The
/// checksum is the only thing standing between a typo and an activation
/// attempt, and a key that fails it is a key somebody has paid for and cannot
/// use. The vectors below were produced by the original in
/// `packages/shared/src/license-key.ts`.
void main() {
  group('licence keys', () {
    test('a key looks like a key', () {
      final key = generateLicenceKey();
      expect(key, startsWith('QSRV-'));
      expect(key.split('-').length, 5);
      expect(key.replaceAll('-', '').length, 4 + bodyLength + 1);
    });

    test('every generated key passes its own checksum', () {
      for (var i = 0; i < 500; i += 1) {
        final key = generateLicenceKey();
        final bare = key.replaceAll('-', '').substring(4);
        final body = bare.substring(0, bodyLength);
        expect(checksumChar(body), bare[bodyLength],
            reason: 'the checksum this key carries is not the one its body implies');
      }
    });

    test('the checksum agrees with the original implementation', () {
      // Bodies and the character `packages/shared/src/license-key.ts` computes
      // for them. If this ever disagrees, one of the three copies has drifted.
      // Produced by driving `encodeLicenseKey` from packages/shared and
      // reading the last character of what it returns.
      const vectors = {
        '0000000000000000000': '0',
        '1111111111111111111': 'H',
        'ZZZZZZZZZZZZZZZZZZZ': 'F',
        'QSRV0123456789ABCDE': 'D',
      };
      vectors.forEach((body, expected) {
        expect(checksumChar(body), expected, reason: body);
      });
    });

    test('transposing two characters is caught', () {
      // The weighting exists for this: an unweighted sum would not notice, and
      // swapping two characters is the mistake people make reading a key down
      // the phone.
      const body = '0123456789ABCDEFGHJ';
      final swapped = '1023456789ABCDEFGHJ';
      expect(checksumChar(body), isNot(checksumChar(swapped)));
    });

    test('the hint is the last five, without dashes', () {
      expect(keyHint('QSRV-ABCDE-FGHJK-MNPQR-STVWX'), 'STVWX');
    });

    test('the alphabet has no letter anybody can misread', () {
      for (final forbidden in ['I', 'L', 'O', 'U']) {
        expect(alphabet.contains(forbidden), isFalse,
            reason: '$forbidden can be read as something else down a phone line');
      }
      expect(alphabet.length, 32);
    });

    test('a fixed source gives a repeatable key, which is what makes this testable', () {
      expect(generateLicenceKey(Random(7)), generateLicenceKey(Random(7)));
    });
  });
}
