import 'package:flutter/material.dart';

import '../data/api.dart';
import '../data/vault.dart';
import '../design/theme.dart';
import '../i18n/strings.dart';

/// The password, the fingerprint, and the way out.
///
/// Three things, because there are three. An account panel that grows a
/// "preferences" section is an account panel nobody reads.
class AccountSheet extends StatefulWidget {
  const AccountSheet({
    super.key,
    required this.api,
    required this.vault,
    required this.onSignOut,
  });

  final Api api;
  final Vault vault;
  final VoidCallback onSignOut;

  @override
  State<AccountSheet> createState() => _AccountSheetState();
}

class _AccountSheetState extends State<AccountSheet> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _again = TextEditingController();

  bool _busy = false;
  bool _biometricPossible = false;
  bool _biometricOn = false;
  String? _message;
  bool _bad = false;

  @override
  void initState() {
    super.initState();
    _readBiometric();
  }

  Future<void> _readBiometric() async {
    final possible = await widget.vault.biometricPossible();
    final chosen = await widget.vault.biometricChosen();
    if (!mounted) return;
    setState(() {
      _biometricPossible = possible;
      _biometricOn = chosen;
    });
  }

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _again.dispose();
    super.dispose();
  }

  void _say(String message, {bool bad = false}) => setState(() {
        _message = message;
        _bad = bad;
      });

  Future<void> _change() async {
    final s = Strings.of(context);
    final current = _current.text;
    final next = _next.text;

    if (next != _again.text) return _say(s['account.mismatch'], bad: true);
    if (next == current) return _say(s['account.same'], bad: true);
    if (next.length < 8) return _say(s['account.mismatch'], bad: true);

    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await widget.api.changePassword(current, next);
      // The saved sign-in is now the new session's, not the retired one's.
      final session = widget.api.session;
      if (session != null) await widget.vault.keep(session.refreshToken);
      if (!mounted) return;
      _current.clear();
      _next.clear();
      _again.clear();
      _say(s['account.changed']);
    } on ApiError catch (error) {
      if (!mounted) return;
      _say(
        error.offline
            ? s['common.offline']
            : (error.message == 'wrong-password' ? s['account.wrong_current'] : error.message),
        bad: true,
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _toggleBiometric() async {
    final s = Strings.of(context);
    if (_biometricOn) {
      await widget.vault.chooseBiometric(false);
      await _readBiometric();
      return;
    }
    // Proving it once here means the vendor finds out now, in a panel they
    // opened on purpose, rather than on the lock screen tomorrow morning.
    final proved = await widget.vault.prove(s['lock.biometric_reason']);
    if (!proved) return;
    await widget.vault.chooseBiometric(true);
    await _readBiometric();
  }

  @override
  Widget build(BuildContext context) {
    final p = Skin.of(context);
    final s = Strings.of(context);
    final text = Theme.of(context).textTheme;

    return Padding(
      padding: EdgeInsets.only(
        left: 22,
        right: 22,
        top: 4,
        bottom: MediaQuery.of(context).viewInsets.bottom + 26,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s['account.title'], style: text.headlineSmall),
            const SizedBox(height: 2),
            Text(widget.api.session?.email ?? '', style: text.bodySmall),

            const SizedBox(height: 24),
            Text(s['account.password'], style: text.labelSmall),
            const SizedBox(height: 10),
            _password(_current, s['account.current'], autofill: 'current'),
            _password(_next, s['account.next'], autofill: 'new'),
            _password(_again, s['account.again'], autofill: 'new'),
            FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
              onPressed: _busy ? null : _change,
              child: _busy
                  ? SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2.3, color: p.onPrimary),
                    )
                  : Text(s['account.change']),
            ),

            const SizedBox(height: 26),
            Text(s['account.biometric'], style: text.labelSmall),
            const SizedBox(height: 8),
            Row(
              children: [
                Icon(Icons.fingerprint_rounded, size: 26, color: _biometricOn ? p.ok : p.muted),
                const SizedBox(width: 14),
                Expanded(
                  child: Text(
                    !_biometricPossible
                        ? s['account.biometric_none']
                        : (_biometricOn ? s['account.biometric_on'] : s['account.biometric_off']),
                    style: text.bodySmall,
                  ),
                ),
                Switch(
                  value: _biometricOn,
                  onChanged: _biometricPossible ? (_) => _toggleBiometric() : null,
                ),
              ],
            ),

            if (_message != null) ...[
              const SizedBox(height: 18),
              Text(
                _message!,
                style: TextStyle(color: _bad ? p.danger : p.ok, fontSize: 13.5),
              ),
            ],

            const SizedBox(height: 26),
            OutlinedButton.icon(
              onPressed: () async {
                await widget.vault.forget();
                widget.api.signOut();
                widget.onSignOut();
              },
              style: OutlinedButton.styleFrom(foregroundColor: p.danger),
              icon: const Icon(Icons.logout_rounded, size: 19),
              label: Text(s['account.signout']),
            ),
            const SizedBox(height: 6),
            Text(s['account.signout_body'], style: text.bodySmall, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }

  Widget _password(TextEditingController controller, String label, {required String autofill}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextField(
        controller: controller,
        obscureText: true,
        enabled: !_busy,
        autocorrect: false,
        enableSuggestions: false,
        textDirection: TextDirection.ltr,
        autofillHints: [
          autofill == 'current' ? AutofillHints.password : AutofillHints.newPassword,
        ],
        decoration: InputDecoration(labelText: label),
      ),
    );
  }
}
