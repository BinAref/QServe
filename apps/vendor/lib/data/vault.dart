import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';

/// Where the saved sign-in lives, and what has to happen before it is used.
///
/// Holding the refresh token *is* being the vendor — it opens the database
/// with no password. On the web console that token sat in browser storage and
/// the best available answer was to encrypt it with a key a passkey produces.
/// Here there is a better answer and it is the platform's: the Android
/// keystore and the Windows credential store, which are hardware-backed where
/// the hardware exists, are not readable by other applications, and do not
/// depend on a browser being willing to hand anything back.
///
/// The fingerprint is a separate question from the storage, and kept separate:
/// storage decides who *can* read the token, and [unlock] decides whether this
/// person is asked to prove they are the owner of the device before it is
/// read. Turning the fingerprint off does not put the token in the clear.
class Vault {
  Vault({FlutterSecureStorage? storage, LocalAuthentication? auth})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            ),
        _auth = auth ?? LocalAuthentication();

  final FlutterSecureStorage _storage;
  final LocalAuthentication _auth;

  static const _refresh = 'qserve.refresh';
  static const _biometric = 'qserve.biometric';

  /* -------------------------------------------------------- the saved token */

  Future<String?> savedToken() async {
    try {
      return await _storage.read(key: _refresh);
    } catch (_) {
      // A keystore that will not open is a keystore that holds nothing useful.
      return null;
    }
  }

  Future<void> keep(String refreshToken) async {
    try {
      await _storage.write(key: _refresh, value: refreshToken);
    } catch (_) {
      // Not being able to remember the sign-in is not a reason to refuse to
      // work; it means the password is asked for next time.
    }
  }

  Future<void> forget() async {
    try {
      await _storage.delete(key: _refresh);
      await _storage.delete(key: _biometric);
    } catch (_) {
      // Nothing to forget.
    }
  }

  /* --------------------------------------------------------- the fingerprint */

  /// Whether this device has a fingerprint, a face or an iris actually set up
  /// — not whether it has the hardware. A phone with a fingerprint reader and
  /// no enrolled finger cannot check anybody, and offering it would be an
  /// invitation to a dialog that fails.
  Future<bool> biometricPossible() async {
    try {
      if (!await _auth.isDeviceSupported()) return false;
      return await _auth.canCheckBiometrics && (await _auth.getAvailableBiometrics()).isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  Future<bool> biometricChosen() async {
    try {
      return await _storage.read(key: _biometric) == 'yes';
    } catch (_) {
      return false;
    }
  }

  Future<void> chooseBiometric(bool on) async {
    try {
      await _storage.write(key: _biometric, value: on ? 'yes' : 'no');
    } catch (_) {
      // The choice does not survive; the password still works.
    }
  }

  /// Ask for the finger or the face. `false` means refused or cancelled —
  /// which is not an error, it is somebody deciding to type their password.
  Future<bool> prove(String reason) async {
    try {
      return await _auth.authenticate(
        localizedReason: reason,
        options: const AuthenticationOptions(
          // The device PIN is allowed as well. A fingerprint reader that has
          // stopped reading in winter is a real thing, and the alternative
          // here is not weaker — it is the same lock the phone already has.
          biometricOnly: false,
          stickyAuth: true,
          useErrorDialogs: true,
        ),
      );
    } catch (_) {
      return false;
    }
  }
}
