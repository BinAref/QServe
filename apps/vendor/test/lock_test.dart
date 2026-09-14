import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:qserve_vendor/data/api.dart';
import 'package:qserve_vendor/data/attempts.dart';
import 'package:qserve_vendor/data/vault.dart';
import 'package:qserve_vendor/design/theme.dart';
import 'package:qserve_vendor/i18n/strings.dart';
import 'package:qserve_vendor/main.dart';
import 'package:qserve_vendor/screens/lock.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The way in, tested as the screen somebody is actually stuck on.
///
/// Two of these exist because of what a screenshot showed and a build did not:
/// the language and appearance controls were not on the screen at all, and the
/// card was not where it looked as though it should be. A screenshot finds
/// that once; a test finds it every time.

/// The background animates for ever, so nothing ever "settles". Pump enough
/// frames for the entrance to finish and stop.
Future<void> settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 700));
  await tester.pump(const Duration(milliseconds: 700));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  /// A vault that answers without a platform under it.
  final vault = _NoVault();

  Future<Widget> lockScreen() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final settings = Settings(prefs);

    final api = Api(client: MockClient((request) async {
      return http.Response(jsonEncode({'error': 'nope'}), 400);
    }));

    return MaterialApp(
      locale: const Locale('en'),
      supportedLocales: Strings.supported,
      localizationsDelegates: const [StringsDelegate()],
      theme: buildTheme(Palette.dark, dark: true),
      builder: (context, child) =>
          Skin(palette: Palette.dark, child: child ?? const SizedBox.shrink()),
      home: LockScreen(
        api: api,
        vault: vault,
        settings: settings,
        attempts: Attempts.open(),
        onOpen: () {},
      ),
    );
  }

  testWidgets('asks for a password and nothing else', (tester) async {
    await tester.pumpWidget(await lockScreen());
    await settle(tester);

    expect(find.text('Enter your password'), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget,
        reason: 'one field: no email, no address, no project');
    expect(find.text('Open'), findsOneWidget);
  });

  testWidgets('the language and the appearance are on this screen', (tester) async {
    await tester.pumpWidget(await lockScreen());
    await settle(tester);

    // The whole reason they are here: a device that arrived in a language the
    // vendor cannot read makes this the screen they are stuck on.
    expect(find.text('Match the device'), findsNWidgets(2),
        reason: 'one chip for the language, one for the appearance');
  });

  testWidgets('the language chip opens a list with the three languages', (tester) async {
    await tester.pumpWidget(await lockScreen());
    await settle(tester);

    await tester.tap(find.text('Match the device').first);
    await settle(tester);

    expect(find.text('English'), findsOneWidget);
    expect(find.text('العربية'), findsOneWidget);
    expect(find.text('Türkçe'), findsOneWidget);
  });

  testWidgets('the card sits in the middle of the screen', (tester) async {
    tester.view.physicalSize = const Size(900, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(await lockScreen());
    await settle(tester);

    final field = tester.getRect(find.byType(TextField));
    final screen = tester.getRect(find.byType(Scaffold));
    final fieldCentre = field.left + field.width / 2;
    final screenCentre = screen.left + screen.width / 2;

    expect((fieldCentre - screenCentre).abs(), lessThan(2),
        reason: 'the card was drawn to one side, which a screenshot found first');
    expect(field.width, lessThanOrEqualTo(400));
  });

  testWidgets('a wrong password costs an attempt and says how many are left',
      (tester) async {
    await tester.pumpWidget(await lockScreen());
    await settle(tester);

    await tester.enterText(find.byType(TextField), 'not-the-password');
    await tester.tap(find.text('Open'));
    await settle(tester);

    expect(find.textContaining('4 attempts left'), findsOneWidget);
  });
}

/// No keystore, no fingerprint reader, no saved sign-in — a fresh install on a
/// plain device, which is the state this screen has to be right in.
class _NoVault implements Vault {
  @override
  Future<bool> biometricPossible() async => false;

  @override
  Future<bool> biometricChosen() async => false;

  @override
  Future<void> chooseBiometric(bool on) async {}

  @override
  Future<void> forget() async {}

  @override
  Future<void> keep(String refreshToken) async {}

  @override
  Future<bool> prove(String reason) async => false;

  @override
  Future<String?> savedToken() async => null;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
