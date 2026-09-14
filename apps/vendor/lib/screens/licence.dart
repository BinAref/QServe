import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart' hide TextDirection;

import '../data/api.dart';
import '../design/theme.dart';
import '../design/widgets.dart';
import '../i18n/strings.dart';

/// One licence: who has it, what it opens, what happened to it, and what the
/// vendor wrote down about it.
class LicenceScreen extends StatefulWidget {
  const LicenceScreen({
    super.key,
    required this.api,
    required this.licence,
    required this.restaurant,
  });

  final Api api;
  final Licence licence;
  final Restaurant? restaurant;

  @override
  State<LicenceScreen> createState() => _LicenceScreenState();
}

class _LicenceScreenState extends State<LicenceScreen> {
  late final _notes = TextEditingController(text: widget.licence.notes ?? '');
  bool _changed = false;
  bool _savingNotes = false;

  @override
  void dispose() {
    _notes.dispose();
    super.dispose();
  }

  String _when(DateTime? at) =>
      at == null ? '—' : DateFormat.yMMMd(Strings.of(context).locale.languageCode).add_Hm().format(at.toLocal());

  @override
  Widget build(BuildContext context) {
    final p = Skin.of(context);
    final s = Strings.of(context);
    final text = Theme.of(context).textTheme;
    final l = widget.licence;

    final (label, colour) = switch (l.status) {
      LicenceStatus.active => (s['status.active'], p.ok),
      LicenceStatus.cancelled => (s['status.cancelled'], p.danger),
      LicenceStatus.pending => (s['status.pending'], p.warn),
    };

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.of(context).pop(_changed);
      },
      child: Scaffold(
        appBar: AppBar(title: Text(s['licence.title'])),
        body: ListView(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 40),
          children: [
            Stagger(children: [
              Row(
                children: [
                  Expanded(child: Text(l.restaurantName, style: text.headlineMedium)),
                  const SizedBox(width: 12),
                  StatusPill(label: label, colour: colour),
                ],
              ),
              const SizedBox(height: 4),
              Text('${l.restaurantId} · ${l.licenceId}', style: text.bodySmall),
              const SizedBox(height: 20),

              _keyPanel(p, s, l),
              const SizedBox(height: 14),

              Panel(
                child: Column(
                  children: [
                    _row(s['licence.issued'], _when(l.createdAt)),
                    if (l.activatedAt != null) _row(s['licence.activated'], _when(l.activatedAt)),
                    if (l.deviceLabel != null) _row(s['licence.device'], l.deviceLabel!),
                    if (l.appVersion != null) _row('QServe', l.appVersion!),
                    if (widget.restaurant?.contactName != null)
                      _row(s['issue.contact'], widget.restaurant!.contactName!),
                    if (widget.restaurant?.contactPhone != null)
                      _row(s['issue.phone'], widget.restaurant!.contactPhone!, ltr: true),
                    if (widget.restaurant?.contactEmail != null)
                      _row(s['issue.email'], widget.restaurant!.contactEmail!, ltr: true),
                    if (widget.restaurant?.country != null)
                      _row(s['issue.country'], widget.restaurant!.country!),
                  ],
                ),
              ),
              const SizedBox(height: 14),

              _notesPanel(p, s),
              const SizedBox(height: 22),

              if (l.status != LicenceStatus.cancelled)
                OutlinedButton.icon(
                  onPressed: _cancel,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: p.danger,
                    side: BorderSide(color: p.danger.withValues(alpha: 0.5)),
                  ),
                  icon: const Icon(Icons.delete_outline_rounded, size: 20),
                  label: Text(s['licence.cancel']),
                ),
            ]),
          ],
        ),
      ),
    );
  }

  Widget _keyPanel(Palette p, Strings s, Licence l) {
    final key = l.key;
    return Panel(
      padding: const EdgeInsets.fromLTRB(18, 16, 12, 16),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s['licence.key_hint'], style: Theme.of(context).textTheme.labelSmall),
                const SizedBox(height: 6),
                Directionality(
                  textDirection: TextDirection.ltr,
                  child: SelectableText(
                    key ?? '···${l.keyHint ?? ''}',
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.0,
                      color: p.text,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ),
              ],
            ),
          ),
          if (key != null)
            IconButton(
              tooltip: s['issue.copy'],
              icon: const Icon(Icons.copy_rounded, size: 20),
              onPressed: () {
                Clipboard.setData(ClipboardData(text: key));
                ScaffoldMessenger.of(context)
                    .showSnackBar(SnackBar(content: Text(s['issue.copied'])));
              },
            ),
        ],
      ),
    );
  }

  Widget _notesPanel(Palette p, Strings s) {
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(s['licence.notes'], style: Theme.of(context).textTheme.labelSmall),
          const SizedBox(height: 10),
          TextField(
            controller: _notes,
            maxLines: 4,
            minLines: 2,
            decoration: InputDecoration(hintText: s['issue.notes_hint']),
          ),
          const SizedBox(height: 12),
          Align(
            alignment: AlignmentDirectional.centerEnd,
            child: FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size(110, 44)),
              onPressed: _savingNotes ? null : _saveNotes,
              child: _savingNotes
                  ? SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2.2, color: p.onPrimary),
                    )
                  : Text(s['common.save']),
            ),
          ),
        ],
      ),
    );
  }

  Widget _row(String label, String value, {bool ltr = false}) {
    final p = Skin.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 118,
            child: Text(label, style: TextStyle(color: p.muted, fontSize: 13.5)),
          ),
          Expanded(
            child: ltr
                ? Directionality(
                    textDirection: TextDirection.ltr,
                    child: Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: Text(value, style: const TextStyle(fontSize: 14)),
                    ),
                  )
                : Text(value, style: const TextStyle(fontSize: 14)),
          ),
        ],
      ),
    );
  }

  /* ------------------------------------------------------------------ doing */

  Future<void> _saveNotes() async {
    setState(() => _savingNotes = true);
    final s = Strings.of(context);
    try {
      await widget.api.setLicenceNotes(widget.licence.licenceId, _notes.text.trim());
      _changed = true;
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s['licence.notes_saved'])));
    } on ApiError catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(error.offline ? s['common.offline'] : error.message),
      ));
    } finally {
      if (mounted) setState(() => _savingNotes = false);
    }
  }

  Future<void> _cancel() async {
    final s = Strings.of(context);
    final reason = TextEditingController();

    final go = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(s['licence.cancel']),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(s['licence.cancel_warn']),
            const SizedBox(height: 16),
            TextField(
              controller: reason,
              maxLength: 200,
              decoration: InputDecoration(labelText: s['licence.cancel_reason']),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialog).pop(false),
            child: Text(s['common.cancel']),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Skin.of(dialog).danger,
              foregroundColor: Colors.white,
              minimumSize: const Size(110, 44),
            ),
            onPressed: () => Navigator.of(dialog).pop(true),
            child: Text(s['licence.cancel']),
          ),
        ],
      ),
    );
    reason.dispose();
    if (go != true || !mounted) return;

    try {
      await widget.api.deleteLicence(widget.licence.licenceId, reason.text.trim());
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s['licence.cancelled'])));
      Navigator.of(context).pop(true);
    } on ApiError catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(error.offline ? s['common.offline'] : error.message),
      ));
    }
  }
}
