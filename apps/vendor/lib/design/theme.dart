import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// How this application looks, decided in one place.
///
/// The colours are the ones the rest of QServe already uses, so the licence
/// console and the restaurant console read as one product. What is different
/// here is the execution: real depth, real spacing, and a single confident
/// accent rather than a page of grey boxes with a blue button somewhere in it.
///
/// Both schemes are written out in full rather than seeded from one colour.
/// A seeded scheme is a quick way to get something that works and a slow way
/// to get something that looks considered — it decides, on your behalf, that
/// your surfaces are tinted with your brand, and the result is recognisably
/// "a Material app" rather than this one.
class Palette {
  const Palette({
    required this.background,
    required this.surface,
    required this.surfaceHigh,
    required this.border,
    required this.text,
    required this.muted,
    required this.primary,
    required this.onPrimary,
    required this.ok,
    required this.warn,
    required this.danger,
    required this.glowA,
    required this.glowB,
  });

  final Color background;
  final Color surface;
  final Color surfaceHigh;
  final Color border;
  final Color text;
  final Color muted;
  final Color primary;
  final Color onPrimary;
  final Color ok;
  final Color warn;
  final Color danger;

  /// The two lights behind the lock screen. They are part of the palette
  /// rather than the screen, because a colour that appears nowhere else is how
  /// a sign-in page ends up looking like a different application.
  final Color glowA;
  final Color glowB;

  static const dark = Palette(
    background: Color(0xFF0B0E13),
    surface: Color(0xFF141922),
    surfaceHigh: Color(0xFF1C232E),
    border: Color(0xFF2A313C),
    text: Color(0xFFE8ECF2),
    muted: Color(0xFF98A2B0),
    primary: Color(0xFF5B8CFF),
    onPrimary: Color(0xFF07142E),
    ok: Color(0xFF47CD89),
    warn: Color(0xFFE0AA3E),
    danger: Color(0xFFF97066),
    glowA: Color(0xFF2B4CC7),
    glowB: Color(0xFF1B7F8E),
  );

  static const light = Palette(
    background: Color(0xFFF3F5F9),
    surface: Color(0xFFFFFFFF),
    surfaceHigh: Color(0xFFF7F9FC),
    border: Color(0xFFDFE4EC),
    text: Color(0xFF121722),
    muted: Color(0xFF5B6675),
    primary: Color(0xFF1A56DB),
    onPrimary: Color(0xFFFFFFFF),
    ok: Color(0xFF067647),
    warn: Color(0xFF9A6700),
    danger: Color(0xFFB42318),
    glowA: Color(0xFFBBD0FF),
    glowB: Color(0xFFBFE7EC),
  );
}

/// The palette for the scheme in force, reachable from any widget.
///
/// Flutter's own `Theme.of` gives a ColorScheme, which has a fixed set of
/// roles that do not include "the second light behind the lock screen" or "the
/// colour a cancelled licence is written in". Rather than bend those roles
/// into meaning something else — which is how `secondaryContainer` ends up
/// being a status badge — the palette travels beside the theme.
class Skin extends InheritedWidget {
  const Skin({super.key, required this.palette, required super.child});

  final Palette palette;

  static Palette of(BuildContext context) {
    final skin = context.dependOnInheritedWidgetOfExactType<Skin>();
    assert(skin != null, 'no Skin above this widget');
    return skin!.palette;
  }

  @override
  bool updateShouldNotify(Skin old) => old.palette != palette;
}

/// Corner radii, in the two sizes this application uses.
///
/// Two, not seven. A set of radii that grows every time somebody adds a
/// component is how an interface stops looking as though one person drew it.
class Radii {
  static const small = BorderRadius.all(Radius.circular(12));
  static const large = BorderRadius.all(Radius.circular(20));
  static const pill = BorderRadius.all(Radius.circular(999));
}

/// One duration and one curve for anything that moves on its own, and a
/// slower pair for anything a whole screen does.
class Motion {
  static const quick = Duration(milliseconds: 180);
  static const normal = Duration(milliseconds: 320);
  static const slow = Duration(milliseconds: 560);

  /// Fast out, settling in — movement that starts decisively and arrives
  /// without a bounce. A bounce reads as playful, and this application deletes
  /// licences people have paid for.
  static const curve = Curves.easeOutCubic;
  static const emphasised = Cubic(0.2, 0, 0, 1);
}

ThemeData buildTheme(Palette p, {required bool dark}) {
  final base = dark ? ThemeData.dark() : ThemeData.light();

  final scheme = (dark ? const ColorScheme.dark() : const ColorScheme.light()).copyWith(
    brightness: dark ? Brightness.dark : Brightness.light,
    primary: p.primary,
    onPrimary: p.onPrimary,
    surface: p.surface,
    onSurface: p.text,
    error: p.danger,
    outline: p.border,
  );

  /*
   * One family, four weights, and sizes that step rather than drift. The
   * system font is deliberate: a downloaded typeface on a phone with no signal
   * is a screen of squares, and this application is opened in places with bad
   * signal.
   */
  TextStyle t(double size, FontWeight weight, {Color? colour, double? height, double? spacing}) =>
      TextStyle(
        fontSize: size,
        fontWeight: weight,
        color: colour ?? p.text,
        height: height ?? 1.35,
        letterSpacing: spacing,
      );

  return base.copyWith(
    colorScheme: scheme,
    scaffoldBackgroundColor: p.background,
    canvasColor: p.background,
    dividerColor: p.border,
    splashFactory: InkSparkle.splashFactory,
    visualDensity: VisualDensity.standard,
    textTheme: TextTheme(
      displaySmall: t(34, FontWeight.w700, height: 1.15, spacing: -0.6),
      headlineMedium: t(26, FontWeight.w700, height: 1.2, spacing: -0.3),
      headlineSmall: t(21, FontWeight.w600, height: 1.25, spacing: -0.2),
      titleMedium: t(17, FontWeight.w600),
      titleSmall: t(15, FontWeight.w600),
      bodyLarge: t(16, FontWeight.w400),
      bodyMedium: t(14.5, FontWeight.w400),
      bodySmall: t(13, FontWeight.w400, colour: p.muted),
      labelLarge: t(15, FontWeight.w600),
      labelSmall: t(12, FontWeight.w600, colour: p.muted, spacing: 0.4),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: p.background,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      systemOverlayStyle: dark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark,
      titleTextStyle: t(19, FontWeight.w700, spacing: -0.2),
      iconTheme: IconThemeData(color: p.text),
    ),
    cardTheme: CardThemeData(
      color: p.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: Radii.large, side: BorderSide(color: p.border)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.surfaceHigh,
      contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
      hintStyle: t(16, FontWeight.w400, colour: p.muted),
      labelStyle: t(14, FontWeight.w500, colour: p.muted),
      border: OutlineInputBorder(borderRadius: Radii.small, borderSide: BorderSide(color: p.border)),
      enabledBorder:
          OutlineInputBorder(borderRadius: Radii.small, borderSide: BorderSide(color: p.border)),
      focusedBorder: OutlineInputBorder(
        borderRadius: Radii.small,
        borderSide: BorderSide(color: p.primary, width: 2),
      ),
      errorBorder:
          OutlineInputBorder(borderRadius: Radii.small, borderSide: BorderSide(color: p.danger)),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: Radii.small,
        borderSide: BorderSide(color: p.danger, width: 2),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: p.primary,
        foregroundColor: p.onPrimary,
        minimumSize: const Size.fromHeight(56),
        shape: const RoundedRectangleBorder(borderRadius: Radii.small),
        textStyle: t(16, FontWeight.w600),
        disabledBackgroundColor: p.border,
        disabledForegroundColor: p.muted,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: p.primary,
        textStyle: t(15, FontWeight.w600),
        shape: const RoundedRectangleBorder(borderRadius: Radii.small),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: p.text,
        minimumSize: const Size.fromHeight(52),
        side: BorderSide(color: p.border),
        shape: const RoundedRectangleBorder(borderRadius: Radii.small),
        textStyle: t(15, FontWeight.w600),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: p.surfaceHigh,
      contentTextStyle: t(14.5, FontWeight.w500),
      behavior: SnackBarBehavior.floating,
      shape: const RoundedRectangleBorder(borderRadius: Radii.small),
      insetPadding: const EdgeInsets.all(16),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: p.surface,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(borderRadius: Radii.large),
      titleTextStyle: t(20, FontWeight.w700),
      contentTextStyle: t(14.5, FontWeight.w400, colour: p.muted),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: p.surface,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      showDragHandle: true,
      dragHandleColor: p.border,
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: p.primary, linearMinHeight: 3),
    iconTheme: IconThemeData(color: p.muted),
  );
}
