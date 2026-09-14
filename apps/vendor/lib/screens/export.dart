import 'dart:io';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../data/api.dart';
import '../i18n/strings.dart';

/// Everything, as a file a spreadsheet opens.
///
/// One row per licence with its restaurant beside it, because that is the
/// shape somebody sorts and filters — a file with restaurants in one sheet and
/// licences in another is a file that needs a lookup before it can answer
/// "who has an active licence in Turkey".
Future<void> exportEverything(BuildContext context, List<Restaurant> restaurants) async {
  final messenger = ScaffoldMessenger.of(context);
  final s = Strings.of(context);

  final rows = <List<String>>[
    [
      'Restaurant ID', 'Restaurant', 'Contact', 'Phone', 'Email', 'Country',
      'Restaurant notes', 'Licence ID', 'Key', 'Status', 'Issued', 'Activated',
      'Device', 'Device ID', 'QServe version', 'Licence notes',
    ],
  ];

  final when = DateFormat('yyyy-MM-dd HH:mm');
  String at(DateTime? t) => t == null ? '' : when.format(t.toLocal());

  for (final r in restaurants) {
    if (r.licences.isEmpty) {
      rows.add([
        r.restaurantId, r.name, r.contactName ?? '', r.contactPhone ?? '',
        r.contactEmail ?? '', r.country ?? '', r.notes ?? '',
        '', '', '', at(r.createdAt), '', '', '', '', '',
      ]);
      continue;
    }
    for (final l in r.licences) {
      rows.add([
        r.restaurantId, r.name, r.contactName ?? '', r.contactPhone ?? '',
        r.contactEmail ?? '', r.country ?? '', r.notes ?? '',
        l.licenceId, l.key ?? (l.keyHint == null ? '' : '...${l.keyHint}'),
        l.status.name, at(l.createdAt), at(l.activatedAt),
        l.deviceLabel ?? '', l.device ?? '', l.appVersion ?? '', l.notes ?? '',
      ]);
    }
  }

  final csv = rows.map((row) => row.map(_cell).join(',')).join('\r\n');
  final name = 'qserve-licences-${DateFormat('yyyy-MM-dd').format(DateTime.now())}.csv';

  try {
    final dir = await getApplicationDocumentsDirectory();
    final file = File('${dir.path}${Platform.pathSeparator}$name');
    // A byte-order mark, because Excel opens a UTF-8 CSV without one as
    // whatever the machine's code page happens to be — which turns every
    // Arabic restaurant name into punctuation.
    await file.writeAsString('﻿$csv');

    await Share.shareXFiles(
      [XFile(file.path, mimeType: 'text/csv', name: name)],
      subject: name,
    );
  } catch (_) {
    messenger.showSnackBar(SnackBar(content: Text(s['common.failed'])));
  }
}

/// A CSV cell, and the reason this is not `join(',')`.
///
/// A leading `=`, `+`, `-` or `@` makes a spreadsheet treat the text as a
/// formula, so a restaurant named after a sum, or a note beginning with a
/// minus, becomes something the spreadsheet tries to run. Prefixing an
/// apostrophe is what stops that, and quoting is what stops a comma in a name
/// from becoming a new column.
String _cell(String value) {
  var text = value;
  if (text.isNotEmpty && '=+-@\t\r'.contains(text[0])) text = "'$text";
  return RegExp('[",\r\n]').hasMatch(text) ? '"${text.replaceAll('"', '""')}"' : text;
}
