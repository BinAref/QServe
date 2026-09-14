import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/api.dart';
import '../data/licence_key.dart';
import '../design/theme.dart';
import '../i18n/strings.dart';

/// Issuing a licence: for a restaurant that is already here, or for one that
/// is not yet.
///
/// Issuing does not touch any licence that already exists. A restaurant moving
/// to a new computer is issued another one like anybody else, and the old one
/// stops when the vendor decides it stops — which is the whole of the rule
/// that replaced transfers.
class IssueScreen extends StatefulWidget {
  const IssueScreen({super.key, required this.api, required this.restaurants});

  final Api api;
  final List<Restaurant> restaurants;

  @override
  State<IssueScreen> createState() => _IssueScreenState();
}

class _IssueScreenState extends State<IssueScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _contact = TextEditingController();
  final _phone = TextEditingController();
  final _email = TextEditingController();
  final _country = TextEditingController();
  final _notes = TextEditingController();

  Restaurant? _existing;
  bool _busy = false;
  String? _failure;

  @override
  void dispose() {
    for (final c in [_name, _contact, _phone, _email, _country, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    if (_existing == null && !(_form.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _failure = null;
    });

    // Made here, sent with its hash. The database keeps both: the hash is what
    // an activation is checked against, and the key is readable because a
    // customer who has lost it rings the vendor.
    final key = generateLicenceKey();

    try {
      final issued = await widget.api.issue(
        restaurantId: _existing?.restaurantId,
        restaurantName: _existing == null ? _name.text.trim() : null,
        contactName: _text(_contact),
        contactPhone: _text(_phone),
        contactEmail: _text(_email),
        country: _text(_country),
        notes: _text(_notes),
        key: key,
        keyHash: sha256Hex(key),
        keyHint: keyHint(key),
      );
      if (!mounted) return;
      await _showKey(issued);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on ApiError catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _failure = error.offline ? Strings.of(context)['common.offline'] : error.message;
      });
    }
  }

  String? _text(TextEditingController c) => c.text.trim().isEmpty ? null : c.text.trim();

  Future<void> _showKey(IssuedLicence issued) {
    final p = Skin.of(context);
    final s = Strings.of(context);
    return showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialog) => AlertDialog(
        title: Text(s['issue.done']),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
              decoration: BoxDecoration(
                color: p.surfaceHigh,
                borderRadius: Radii.small,
                border: Border.all(color: p.border),
              ),
              child: Directionality(
                textDirection: TextDirection.ltr,
                child: SelectableText(
                  issued.key,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 1.1,
                    color: p.text,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 12),
            Text('${issued.restaurantId} · ${issued.licenceId}',
                style: Theme.of(dialog).textTheme.bodySmall),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () {
              Clipboard.setData(ClipboardData(text: issued.key));
              ScaffoldMessenger.of(dialog)
                  .showSnackBar(SnackBar(content: Text(s['issue.copied'])));
            },
            child: Text(s['issue.copy']),
          ),
          FilledButton(
            style: FilledButton.styleFrom(minimumSize: const Size(96, 44)),
            onPressed: () => Navigator.of(dialog).pop(),
            child: Text(s['common.close']),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = Skin.of(context);
    final s = Strings.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text(s['issue.title']),
        leading: IconButton(
          icon: const Icon(Icons.close_rounded),
          onPressed: () => Navigator.of(context).pop(false),
        ),
      ),
      body: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 40),
          children: [
            Text(s['issue.intro'], style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 18),

            if (widget.restaurants.isNotEmpty) ...[
              DropdownButtonFormField<Restaurant?>(
                initialValue: _existing,
                isExpanded: true,
                decoration: InputDecoration(labelText: s['issue.existing']),
                items: [
                  DropdownMenuItem(value: null, child: Text(s['common.none'])),
                  for (final r in widget.restaurants)
                    DropdownMenuItem(
                      value: r,
                      child: Text(r.name, overflow: TextOverflow.ellipsis),
                    ),
                ],
                onChanged: _busy ? null : (value) => setState(() => _existing = value),
              ),
              const SizedBox(height: 16),
            ],

            // A restaurant already chosen has its details already; asking for
            // them again would be asking somebody to retype what is on screen.
            if (_existing == null) ...[
              _field(_name, s['issue.restaurant'], required: true),
              _field(_contact, s['issue.contact']),
              Row(children: [
                Expanded(child: _field(_phone, s['issue.phone'], ltr: true)),
                const SizedBox(width: 12),
                Expanded(child: _field(_country, s['issue.country'])),
              ]),
              _field(_email, s['issue.email'], ltr: true),
            ],

            _field(_notes, s['issue.notes'], hint: s['issue.notes_hint'], lines: 3),

            if (_failure != null) ...[
              const SizedBox(height: 6),
              Text(_failure!, style: TextStyle(color: p.danger, fontSize: 13.5)),
            ],

            const SizedBox(height: 22),
            FilledButton(
              onPressed: _busy ? null : _submit,
              child: _busy
                  ? SizedBox(
                      width: 21,
                      height: 21,
                      child: CircularProgressIndicator(strokeWidth: 2.4, color: p.onPrimary),
                    )
                  : Text(s['issue.create']),
            ),
          ],
        ),
      ),
    );
  }

  Widget _field(
    TextEditingController controller,
    String label, {
    String? hint,
    bool required = false,
    bool ltr = false,
    int lines = 1,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: TextFormField(
        controller: controller,
        enabled: !_busy,
        maxLines: lines,
        // A telephone number and an email address are typed left to right in
        // every language, so their boxes are, even on an Arabic screen.
        textDirection: ltr ? TextDirection.ltr : null,
        decoration: InputDecoration(labelText: label, hintText: hint),
        validator: required
            ? (value) => (value ?? '').trim().isEmpty ? label : null
            : null,
      ),
    );
  }
}
