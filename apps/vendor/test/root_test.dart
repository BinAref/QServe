import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qserve_vendor/main.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The real root, not a screen lifted out of it.
///
/// The lock screen's own test said the card was centred, and a photograph of
/// the running application said it was not. Both were right: the difference
/// was everything between `runApp` and the screen, which the first test had
/// replaced with a plain MaterialApp. This pumps what actually runs.
Future<void> settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 700));
  await tester.pump(const Duration(milliseconds: 700));
}

void main() {
  testWidgets('the card is centred in the application that actually runs', (tester) async {
    tester.view.physicalSize = const Size(1280, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();

    await tester.pumpWidget(VendorApp(settings: Settings(prefs)));
    await settle(tester);

    final field = tester.getRect(find.byType(TextField));
    expect(field.center.dx, closeTo(640, 2),
        reason: 'a photograph of the running application found it at 800');
  });

  testWidgets('the language and appearance chips are on screen, not below it', (tester) async {
    tester.view.physicalSize = const Size(1280, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();

    await tester.pumpWidget(VendorApp(settings: Settings(prefs)));
    await settle(tester);

    final chips = find.text('Match the device');
    expect(chips, findsNWidgets(2));
    for (var i = 0; i < 2; i += 1) {
      final rect = tester.getRect(chips.at(i));
      expect(rect.bottom, lessThanOrEqualTo(720),
          reason: 'a control below the bottom of the window is a control nobody has');
    }
  });
}
