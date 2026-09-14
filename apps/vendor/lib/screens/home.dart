import 'package:flutter/material.dart';

import '../data/api.dart';
import '../data/vault.dart';
import '../design/theme.dart';
import '../design/widgets.dart';
import '../i18n/strings.dart';
import '../main.dart';
import 'account.dart';
import 'export.dart';
import 'issue.dart';
import 'licence.dart';

/// Everything the vendor came here to do, on one screen.
///
/// A licence is a restaurant plus a key plus what happened to it, and that is
/// how the list reads: one card per licence, the restaurant's name at the top
/// of it, because "which restaurant" is how a vendor remembers a licence and
/// "LIC-2026-000014" is not.
class HomeScreen extends StatefulWidget {
  const HomeScreen({
    super.key,
    required this.api,
    required this.vault,
    required this.settings,
    required this.onSignOut,
  });

  final Api api;
  final Vault vault;
  final Settings settings;
  final VoidCallback onSignOut;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _search = TextEditingController();

  List<Restaurant> _restaurants = [];
  bool _loading = true;
  String? _failure;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _load();
    _search.addListener(() => setState(() => _query = _search.text.trim().toLowerCase()));
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _failure = null);
    try {
      final rows = await widget.api.overview();
      if (!mounted) return;
      setState(() {
        _restaurants = rows;
        _loading = false;
      });
    } on ApiError catch (error) {
      if (!mounted) return;
      setState(() {
        _failure = error.offline ? 'common.offline' : error.message;
        _loading = false;
      });
    }
  }

  /// Flattened, newest first. The grouping that matters is on the card, not in
  /// the scroll: a vendor looking for "the licence I issued on Tuesday" wants
  /// time order, and one looking for a restaurant types its name.
  List<Licence> get _shown {
    final all = _restaurants.expand((r) => r.licences).toList()
      ..sort((a, b) => (b.createdAt ?? DateTime(0)).compareTo(a.createdAt ?? DateTime(0)));
    if (_query.isEmpty) return all;
    return all.where((l) => l.haystack.contains(_query)).toList();
  }

  Restaurant? _restaurantOf(Licence licence) {
    for (final r in _restaurants) {
      if (r.restaurantId == licence.restaurantId) return r;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final p = Skin.of(context);
    final s = Strings.of(context);
    final licences = _shown;

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            _bar(p, s),
            if (_restaurants.isNotEmpty || _query.isNotEmpty) _searchField(p, s),
            Expanded(child: _body(p, s, licences)),
          ],
        ),
      ),
      floatingActionButton: _loading || _failure != null
          ? null
          : FloatingActionButton.extended(
              onPressed: _issue,
              backgroundColor: p.primary,
              foregroundColor: p.onPrimary,
              elevation: 0,
              highlightElevation: 0,
              shape: const RoundedRectangleBorder(borderRadius: Radii.pill),
              icon: const Icon(Icons.add_rounded),
              label: Text(s['home.issue']),
            ),
    );
  }

  Widget _bar(Palette p, Strings s) {
    return Padding(
      padding: const EdgeInsetsDirectional.only(start: 20, end: 10, top: 12, bottom: 6),
      child: Row(
        children: [
          const BrandMark(size: 34),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s['home.title'], style: Theme.of(context).textTheme.headlineSmall),
                if (!_loading && _failure == null)
                  Text(
                    '${_shown.length} · ${_restaurants.length}',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
              ],
            ),
          ),
          IconButton(
            tooltip: s['home.export'],
            onPressed: _restaurants.isEmpty ? null : () => exportEverything(context, _restaurants),
            icon: const Icon(Icons.download_rounded),
          ),
          IconButton(
            tooltip: s['home.account'],
            onPressed: _account,
            icon: const Icon(Icons.person_outline_rounded),
          ),
        ],
      ),
    );
  }

  Widget _searchField(Palette p, Strings s) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 6, 20, 12),
      child: TextField(
        controller: _search,
        decoration: InputDecoration(
          hintText: s['home.search'],
          prefixIcon: Icon(Icons.search_rounded, color: p.muted, size: 21),
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          suffixIcon: _query.isEmpty
              ? null
              : IconButton(
                  icon: Icon(Icons.close_rounded, color: p.muted, size: 19),
                  onPressed: _search.clear,
                ),
        ),
      ),
    );
  }

  Widget _body(Palette p, Strings s, List<Licence> licences) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_failure != null) {
      return Empty(
        icon: Icons.cloud_off_rounded,
        title: s['common.offline'],
        body: _failure == 'common.offline' ? '' : _failure!,
        action: FilledButton(
          onPressed: () {
            setState(() => _loading = true);
            _load();
          },
          child: Text(s['common.retry']),
        ),
      );
    }
    if (licences.isEmpty) {
      return Empty(
        icon: _query.isEmpty ? Icons.receipt_long_rounded : Icons.search_off_rounded,
        title: _query.isEmpty ? s['home.empty_title'] : s['home.none_found'],
        body: _query.isEmpty ? s['home.empty_body'] : '',
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      color: p.primary,
      backgroundColor: p.surface,
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 110),
        itemCount: licences.length,
        separatorBuilder: (_, __) => const SizedBox(height: 12),
        itemBuilder: (context, i) => _LicenceCard(
          licence: licences[i],
          onTap: () => _open(licences[i]),
        ),
      ),
    );
  }

  /* -------------------------------------------------------------- the doors */

  Future<void> _issue() async {
    final issued = await Navigator.of(context).push<bool>(MaterialPageRoute(
      builder: (_) => IssueScreen(api: widget.api, restaurants: _restaurants),
      fullscreenDialog: true,
    ));
    if (issued ?? false) await _load();
  }

  Future<void> _open(Licence licence) async {
    final changed = await Navigator.of(context).push<bool>(MaterialPageRoute(
      builder: (_) => LicenceScreen(
        api: widget.api,
        licence: licence,
        restaurant: _restaurantOf(licence),
      ),
    ));
    if (changed ?? false) await _load();
  }

  Future<void> _account() => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        builder: (_) => AccountSheet(
          api: widget.api,
          vault: widget.vault,
          onSignOut: () {
            Navigator.of(context).pop();
            widget.onSignOut();
          },
        ),
      );
}

class _LicenceCard extends StatelessWidget {
  const _LicenceCard({required this.licence, required this.onTap});

  final Licence licence;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = Skin.of(context);
    final s = Strings.of(context);
    final text = Theme.of(context).textTheme;

    final (label, colour) = switch (licence.status) {
      LicenceStatus.active => (s['status.active'], p.ok),
      LicenceStatus.cancelled => (s['status.cancelled'], p.danger),
      LicenceStatus.pending => (s['status.pending'], p.warn),
    };

    return Panel(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  licence.restaurantName,
                  style: text.titleMedium,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 10),
              StatusPill(label: label, colour: colour),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Icon(Icons.key_rounded, size: 15, color: p.muted),
              const SizedBox(width: 7),
              // A key is Latin characters and dashes, left to right, whatever
              // the screen around it is doing.
              Directionality(
                textDirection: TextDirection.ltr,
                child: Text(
                  licence.key ?? '···${licence.keyHint ?? ''}',
                  style: TextStyle(
                    fontFeatures: const [FontFeature.tabularFigures()],
                    fontSize: 13,
                    color: p.muted,
                    letterSpacing: 0.4,
                  ),
                ),
              ),
            ],
          ),
          if (licence.deviceLabel != null) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                Icon(Icons.computer_rounded, size: 15, color: p.muted),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    licence.deviceLabel!,
                    style: text.bodySmall,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
