import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'data/api.dart';
import 'data/attempts.dart';
import 'data/vault.dart';
import 'design/theme.dart';
import 'i18n/strings.dart';
import 'screens/home.dart';
import 'screens/lock.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  runApp(VendorApp(settings: Settings(prefs)));
}

/// The two choices that belong to the person rather than to the data.
///
/// Both start at "whatever the device does", because that is what everything
/// else on that device does, and both can be changed without leaving the
/// password screen — a phone that arrived in a language the vendor cannot read
/// should not need a trip through Android settings before it can be used.
class Settings extends ChangeNotifier {
  Settings(this._prefs);

  final SharedPreferences _prefs;

  static const _language = 'appearance.language';
  static const _theme = 'appearance.theme';
  static const system = 'system';

  String get language => _prefs.getString(_language) ?? system;
  String get theme => _prefs.getString(_theme) ?? system;

  /// The language actually in force: the chosen one, or the device's if it is
  /// one this application speaks, or English.
  Locale locale(Locale deviceLocale) =>
      language == system ? Strings.resolve(deviceLocale) : Locale(language);

  ThemeMode get themeMode => switch (theme) {
        'light' => ThemeMode.light,
        'dark' => ThemeMode.dark,
        _ => ThemeMode.system,
      };

  Future<void> setLanguage(String value) async {
    await _prefs.setString(_language, value);
    notifyListeners();
  }

  Future<void> setTheme(String value) async {
    await _prefs.setString(_theme, value);
    notifyListeners();
  }
}

class VendorApp extends StatefulWidget {
  const VendorApp({super.key, required this.settings});

  final Settings settings;

  @override
  State<VendorApp> createState() => _VendorAppState();
}

class _VendorAppState extends State<VendorApp> {
  final api = Api();
  final vault = Vault();

  @override
  void initState() {
    super.initState();
    widget.settings.addListener(_repaint);
  }

  @override
  void dispose() {
    widget.settings.removeListener(_repaint);
    super.dispose();
  }

  void _repaint() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final device = WidgetsBinding.instance.platformDispatcher.locale;
    final locale = widget.settings.locale(device);

    return MaterialApp(
      title: 'QServe Licences',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Palette.light, dark: false),
      darkTheme: buildTheme(Palette.dark, dark: true),
      themeMode: widget.settings.themeMode,
      locale: locale,
      supportedLocales: Strings.supported,
      localizationsDelegates: const [
        StringsDelegate(),
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      builder: (context, child) {
        final dark = Theme.of(context).brightness == Brightness.dark;
        final palette = dark ? Palette.dark : Palette.light;

        // The status bar belongs to the page, not to Android's idea of the
        // page: a dark screen with dark icons on it is a screen with no icons.
        SystemChrome.setSystemUIOverlayStyle(SystemUiOverlayStyle(
          statusBarColor: Colors.transparent,
          statusBarIconBrightness: dark ? Brightness.light : Brightness.dark,
          statusBarBrightness: dark ? Brightness.dark : Brightness.light,
          systemNavigationBarColor: palette.background,
          systemNavigationBarIconBrightness: dark ? Brightness.light : Brightness.dark,
        ));

        return Skin(
          palette: palette,
          child: MediaQuery.withClampedTextScaling(
            // Type that has been scaled to 200% turns a licence key into six
            // lines and a button into a word and a half. Readable, capped.
            maxScaleFactor: 1.3,
            child: child ?? const SizedBox.shrink(),
          ),
        );
      },
      home: Gate(api: api, vault: vault, settings: widget.settings),
    );
  }
}

/// Locked or open, and nothing in between.
///
/// There is no address to type, no project to choose and no account to pick.
/// This application knows where it talks and who it is; the only question it
/// has for the person holding it is whether they are the vendor.
class Gate extends StatefulWidget {
  const Gate({super.key, required this.api, required this.vault, required this.settings});

  final Api api;
  final Vault vault;
  final Settings settings;

  @override
  State<Gate> createState() => _GateState();
}

class _GateState extends State<Gate> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: Motion.slow,
      switchInCurve: Motion.emphasised,
      switchOutCurve: Curves.easeIn,
      transitionBuilder: (child, animation) => FadeTransition(
        opacity: animation,
        child: ScaleTransition(
          scale: Tween(begin: 0.98, end: 1.0).animate(animation),
          child: child,
        ),
      ),
      child: _open
          ? HomeScreen(
              key: const ValueKey('home'),
              api: widget.api,
              vault: widget.vault,
              settings: widget.settings,
              onSignOut: () => setState(() => _open = false),
            )
          : LockScreen(
              key: const ValueKey('lock'),
              api: widget.api,
              vault: widget.vault,
              settings: widget.settings,
              attempts: Attempts.open(),
              onOpen: () => setState(() => _open = true),
            ),
    );
  }
}
