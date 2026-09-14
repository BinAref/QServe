import 'package:shared_preferences/shared_preferences.dart';

/// Five wrong passwords a day, and what happens to that count when somebody
/// changes the clock.
///
/// This is a guard on the screen, not the lock on the door. The lock is that a
/// wrong password gets nothing from the licence database — there is no local
/// copy of anything to guess at, and Supabase does its own rate limiting on
/// top. What this stops is somebody picking up an unlocked phone and trying
/// birthdays until something opens.
///
/// The clock is the interesting part. A count that resets after 24 hours can
/// be reset by moving the date forward, so:
///
///   * the window is measured from the first failure, forwards;
///   * every look at this stores the time it was looked at, and a clock that
///     has gone *backwards* since then is treated as tampering — the window is
///     restarted from now rather than forgiven, so winding back cannot buy
///     attempts;
///   * a clock wound forwards past the window does clear it, and that is
///     accepted: it is the vendor's own device, the prize is five more
///     guesses at a password the database will refuse, and the alternative is
///     a device with a genuinely wrong clock locked out for ever.
class Attempts {
  Attempts(this._prefs);

  static const _count = 'lock.failures';
  static const _since = 'lock.window';
  static const _seen = 'lock.seen';
  static const limit = 5;
  static const window = Duration(hours: 24);

  final SharedPreferences _prefs;

  static Future<Attempts> open() async => Attempts(await SharedPreferences.getInstance());

  DateTime get _now => DateTime.now();

  /// How long is left before trying again is allowed. `null` means now.
  Duration? lockedFor() {
    _noticeTheClock();
    if ((_prefs.getInt(_count) ?? 0) < limit) return null;

    final started = DateTime.tryParse(_prefs.getString(_since) ?? '');
    if (started == null) return null;

    final over = started.add(window);
    return over.isAfter(_now) ? over.difference(_now) : null;
  }

  int get remaining {
    _rollIfOver();
    return (limit - (_prefs.getInt(_count) ?? 0)).clamp(0, limit);
  }

  Future<void> failed() async {
    _rollIfOver();
    final count = (_prefs.getInt(_count) ?? 0) + 1;
    if (count == 1 || _prefs.getString(_since) == null) {
      await _prefs.setString(_since, _now.toIso8601String());
    }
    await _prefs.setInt(_count, count);
  }

  Future<void> succeeded() async {
    await _prefs.remove(_count);
    await _prefs.remove(_since);
  }

  /// A window that has genuinely run out is cleared. One that has not is left
  /// alone.
  void _rollIfOver() {
    _noticeTheClock();
    final started = DateTime.tryParse(_prefs.getString(_since) ?? '');
    if (started == null) return;
    if (_now.isAfter(started.add(window))) {
      _prefs.remove(_count);
      _prefs.remove(_since);
    }
  }

  /// Has the clock gone backwards since the last time anybody looked?
  ///
  /// If it has, the window is restarted from now. Winding the date back is the
  /// cheap way to make "24 hours ago" arrive sooner, and this makes it the
  /// expensive way instead.
  void _noticeTheClock() {
    final seen = DateTime.tryParse(_prefs.getString(_seen) ?? '');
    final now = _now;
    if (seen != null && now.isBefore(seen.subtract(const Duration(minutes: 2)))) {
      if (_prefs.getString(_since) != null) {
        _prefs.setString(_since, now.toIso8601String());
      }
    }
    _prefs.setString(_seen, now.toIso8601String());
  }
}
