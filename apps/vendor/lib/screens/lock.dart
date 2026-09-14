import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../config.dart';
import '../data/api.dart';
import '../data/attempts.dart';
import '../data/vault.dart';
import '../design/theme.dart';
import '../design/widgets.dart';
import '../i18n/strings.dart';
import '../main.dart';

/// The whole of the way in.
///
/// A password, and — if this device has a finger or a face and the vendor has
/// said yes once — a button that skips it. No email, because there is one
/// account and the application already knows which. No address, because it
/// already knows where it talks. No project, no key, no QR. The only thing
/// this screen does not already know is whether the person holding the phone
/// is the person who owns it.
///
/// The language and the appearance are here rather than inside, because a
/// device that arrives in the wrong language makes this the screen somebody is
/// stuck on.
class LockScreen extends StatefulWidget {
  const LockScreen({
    super.key,
    required this.api,
    required this.vault,
    required this.settings,
    required this.attempts,
    required this.onOpen,
  });

  final Api api;
  final Vault vault;
  final Settings settings;
  final Future<Attempts> attempts;
  final VoidCallback onOpen;

  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen> with TickerProviderStateMixin {
  final _password = TextEditingController();
  final _focus = FocusNode();

  late final AnimationController _shake =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 480));

  Attempts? _attempts;
  bool _busy = false;
  bool _reveal = false;
  bool _biometricReady = false;
  String? _problem;
  Duration? _lockedFor;
  Timer? _countdown;

  @override
  void initState() {
    super.initState();
    _start();
  }

  Future<void> _start() async {
    final attempts = await widget.attempts;
    final possible = await widget.vault.biometricPossible();
    final chosen = await widget.vault.biometricChosen();
    final saved = await widget.vault.savedToken();
    if (!mounted) return;

    setState(() {
      _attempts = attempts;
      _biometricReady = possible && chosen && saved != null;
      _lockedFor = attempts.lockedFor();
    });
    _tick();

    // Offered, not forced. The prompt appearing before anybody has asked for
    // it is how people learn to dismiss prompts.
    if (_biometricReady && _lockedFor == null) {
      await _withBiometric(silentFailure: true);
    }
  }

  void _tick() {
    _countdown?.cancel();
    if (_lockedFor == null) return;
    _countdown = Timer.periodic(const Duration(seconds: 1), (_) {
      final left = _attempts?.lockedFor();
      if (!mounted) return;
      setState(() => _lockedFor = left);
      if (left == null) _countdown?.cancel();
    });
  }

  @override
  void dispose() {
    _countdown?.cancel();
    _shake.dispose();
    _password.dispose();
    _focus.dispose();
    super.dispose();
  }

  /* ------------------------------------------------------------- opening it */

  Future<void> _refuse(String key) async {
    await _attempts?.failed();
    if (!mounted) return;
    setState(() {
      _problem = key;
      _busy = false;
      _lockedFor = _attempts?.lockedFor();
    });
    _tick();
    _shake.forward(from: 0);
    HapticFeedback.heavyImpact();
  }

  Future<void> _withPassword() async {
    final typed = _password.text;
    if (typed.isEmpty || _busy) return;

    setState(() {
      _busy = true;
      _problem = null;
    });

    try {
      final session = await widget.api.signIn(typed);
      await _attempts?.succeeded();
      // Kept whether or not the fingerprint is on: the storage is the keystore
      // either way, and turning the fingerprint on later should not require
      // signing in again.
      await widget.vault.keep(session.refreshToken);
      if (!mounted) return;
      HapticFeedback.lightImpact();
      widget.onOpen();
    } on ApiError catch (error) {
      if (error.offline) {
        // Not a wrong password, so it does not cost an attempt.
        if (!mounted) return;
        setState(() {
          _problem = 'lock.offline';
          _busy = false;
        });
        return;
      }
      await _refuse(error.message == 'no-account' ? 'lock.no_account' : 'lock.wrong');
    }
  }

  Future<void> _withBiometric({bool silentFailure = false}) async {
    if (_busy) return;
    final reason = Strings.of(context)['lock.biometric_reason'];
    final saved = await widget.vault.savedToken();
    if (saved == null) return;

    final proved = await widget.vault.prove(reason);
    if (!proved || !mounted) return;

    setState(() {
      _busy = true;
      _problem = null;
    });
    try {
      final session = await widget.api.resume(saved);
      await widget.vault.keep(session.refreshToken);
      await _attempts?.succeeded();
      if (!mounted) return;
      HapticFeedback.lightImpact();
      widget.onOpen();
    } on ApiError catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        // A saved sign-in that has expired is not a failed attempt — it is a
        // saved sign-in that has expired, and the answer is the password.
        _problem = silentFailure ? null : (error.offline ? 'lock.offline' : null);
        _biometricReady = error.offline;
      });
      if (!error.offline) await widget.vault.forget();
    }
  }

  /* ------------------------------------------------------------- the screen */

  @override
  Widget build(BuildContext context) {
    final p = Skin.of(context);
    final s = Strings.of(context);
    final text = Theme.of(context).textTheme;
    final locked = _lockedFor != null;

    return Scaffold(
      body: Aurora(
        child: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: Center(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.symmetric(horizontal: 26, vertical: 30),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 400),
                      child: AnimatedBuilder(
                        animation: _shake,
                        builder: (context, child) => Transform.translate(
                          offset: Offset(_shakeOffset(), 0),
                          child: child,
                        ),
                        child: Stagger(
                          from: 18,
                          children: [
                            const Center(child: BrandMark()),
                            const SizedBox(height: 24),
                            Text(s['app.name'],
                                style: text.displaySmall, textAlign: TextAlign.center),
                            const SizedBox(height: 6),
                            Text(
                              locked ? s['lock.locked_title'] : s['lock.prompt'],
                              style: text.bodyMedium?.copyWith(color: p.muted),
                              textAlign: TextAlign.center,
                            ),
                            const SizedBox(height: 30),
                            if (locked) _lockedCard(p, s, text) else _entry(p, s),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              _appearanceRow(s),
            ],
          ),
        ),
      ),
    );
  }

  /// Four quick swings, decaying. Long enough to read as "no", short enough
  /// not to be in the way of typing the right one.
  double _shakeOffset() {
    if (!_shake.isAnimating && _shake.value == 0) return 0;
    final decay = 1 - _shake.value;
    return 11 * decay * (_shake.value * 22 % 2 < 1 ? 1 : -1);
  }

  Widget _entry(Palette p, Strings s) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _password,
          focusNode: _focus,
          obscureText: !_reveal,
          autofocus: false,
          enabled: !_busy,
          textAlign: TextAlign.start,
          // A password is typed, not composed: no autocorrect, no suggestions,
          // and left to right even on an Arabic screen, because that is the
          // direction it was set in.
          autocorrect: false,
          enableSuggestions: false,
          textDirection: TextDirection.ltr,
          style: const TextStyle(fontSize: 17, letterSpacing: 1.2),
          decoration: InputDecoration(
            hintText: s['lock.password'],
            prefixIcon: Icon(Icons.lock_outline_rounded, color: p.muted, size: 21),
            suffixIcon: IconButton(
              icon: Icon(
                _reveal ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                color: p.muted,
                size: 21,
              ),
              onPressed: () => setState(() => _reveal = !_reveal),
            ),
          ),
          onSubmitted: (_) => _withPassword(),
        ),
        AnimatedSize(
          duration: Motion.quick,
          alignment: Alignment.topCenter,
          child: _problem == null
              // Not `width: double.infinity` — an unbounded child inside an
              // AnimatedSize is a child it cannot measure.
              ? const SizedBox.shrink()
              : Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: _problemLine(p, s),
                ),
        ),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: _busy ? null : _withPassword,
          child: _busy
              ? SizedBox(
                  width: 21,
                  height: 21,
                  child: CircularProgressIndicator(strokeWidth: 2.4, color: p.onPrimary),
                )
              : Text(s['lock.open']),
        ),
        if (_biometricReady) ...[
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: _busy ? null : () => _withBiometric(),
            icon: const Icon(Icons.fingerprint_rounded, size: 22),
            label: Text(s['lock.biometric']),
          ),
        ],
      ],
    );
  }

  Widget _problemLine(Palette p, Strings s) {
    final remaining = _attempts?.remaining ?? Attempts.limit;
    final wrong = _problem == 'lock.wrong';
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.error_outline_rounded, size: 17, color: p.danger),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            wrong && remaining > 0
                ? '${s['lock.wrong']} ${s.fill('lock.remaining', {'n': '$remaining'})}'
                : s[_problem!],
            style: TextStyle(color: p.danger, fontSize: 13.5, height: 1.4),
          ),
        ),
      ],
    );
  }

  Widget _lockedCard(Palette p, Strings s, TextTheme text) {
    final left = _lockedFor ?? Duration.zero;
    final hours = left.inHours;
    final minutes = left.inMinutes.remainder(60);
    final spell = hours > 0 ? '${hours}h ${minutes}m' : '${left.inMinutes}m';

    return Panel(
      padding: const EdgeInsets.all(22),
      child: Column(
        children: [
          Icon(Icons.timelapse_rounded, size: 34, color: p.warn),
          const SizedBox(height: 14),
          Text(
            s.fill('lock.locked_body', {'time': spell}),
            style: text.bodyMedium?.copyWith(color: p.muted),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }

  /* --------------------------------------------------- language and appearance */

  Widget _appearanceRow(Strings s) {
    final settings = widget.settings;
    final languageLabel = settings.language == Settings.system
        ? s['language.system']
        : Strings.names[settings.language] ?? settings.language;
    final themeLabel = s['theme.${settings.theme}'];

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          QuietChip(
            icon: Icons.translate_rounded,
            label: languageLabel,
            onTap: () => _pick(
              title: s['lock.language'],
              current: settings.language,
              options: {
                Settings.system: s['language.system'],
                for (final entry in Strings.names.entries) entry.key: entry.value,
              },
              onChosen: settings.setLanguage,
            ),
          ),
          const SizedBox(width: 4),
          QuietChip(
            icon: Icons.contrast_rounded,
            label: themeLabel,
            onTap: () => _pick(
              title: s['lock.theme'],
              current: settings.theme,
              options: {
                Settings.system: s['theme.system'],
                'light': s['theme.light'],
                'dark': s['theme.dark'],
              },
              onChosen: settings.setTheme,
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _pick({
    required String title,
    required String current,
    required Map<String, String> options,
    required Future<void> Function(String) onChosen,
  }) async {
    final p = Skin.of(context);
    await showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 4, 22, 12),
              child: Text(title, style: Theme.of(sheet).textTheme.titleMedium),
            ),
            for (final entry in options.entries)
              ListTile(
                title: Text(entry.value),
                trailing: entry.key == current
                    ? Icon(Icons.check_rounded, color: p.primary)
                    : null,
                onTap: () async {
                  Navigator.of(sheet).pop();
                  await onChosen(entry.key);
                },
              ),
            const SizedBox(height: 10),
          ],
        ),
      ),
    );
  }
}

/// Whether this build has anybody to sign in as. Shown once, on the screen
/// where it matters, rather than as a failure that looks like a wrong password.
bool get buildHasAccount => vendorEmail.isNotEmpty;
