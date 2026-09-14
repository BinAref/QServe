import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'theme.dart';

/// The two lights behind the lock screen.
///
/// A flat background makes a sign-in page look like a form. Two large, soft,
/// slowly drifting lights make it look like a place — and cost one repaint of
/// two blurred circles, which a phone from 2016 does without noticing.
///
/// Nothing here is random per frame. The lights follow two sine waves at
/// different periods, so the movement never repeats exactly and never jitters.
class Aurora extends StatefulWidget {
  const Aurora({super.key, required this.child});

  final Widget child;

  @override
  State<Aurora> createState() => _AuroraState();
}

class _AuroraState extends State<Aurora> with SingleTickerProviderStateMixin {
  late final AnimationController _drift = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 26),
  )..repeat();

  @override
  void dispose() {
    _drift.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = Skin.of(context);
    return Stack(
      fit: StackFit.expand,
      children: [
        ColoredBox(color: p.background),
        AnimatedBuilder(
          animation: _drift,
          builder: (context, _) => CustomPaint(
            painter: _AuroraPainter(_drift.value, p),
            isComplex: false,
          ),
        ),
        widget.child,
      ],
    );
  }
}

class _AuroraPainter extends CustomPainter {
  _AuroraPainter(this.t, this.palette);

  final double t;
  final Palette palette;

  @override
  void paint(Canvas canvas, Size size) {
    void light(Color colour, double phase, double radius, double opacity) {
      final angle = (t + phase) * 2 * math.pi;
      final centre = Offset(
        size.width * (0.5 + 0.34 * math.cos(angle)),
        size.height * (0.34 + 0.22 * math.sin(angle * 0.7)),
      );
      final paint = Paint()
        ..shader = RadialGradient(
          colors: [colour.withValues(alpha: opacity), colour.withValues(alpha: 0)],
        ).createShader(Rect.fromCircle(center: centre, radius: radius));
      canvas.drawCircle(centre, radius, paint);
    }

    final reach = size.shortestSide * 0.95;
    light(palette.glowA, 0, reach, 0.55);
    light(palette.glowB, 0.45, reach * 0.85, 0.45);
  }

  @override
  bool shouldRepaint(_AuroraPainter old) => old.t != t || old.palette != palette;
}

/// The mark. A rounded square with a gradient and two letters in it — the same
/// QS that sits in the corner of every other QServe screen.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 76});

  final double size;

  @override
  Widget build(BuildContext context) {
    final p = Skin.of(context);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * 0.3),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [p.primary, Color.lerp(p.primary, p.glowB, 0.65)!],
        ),
        boxShadow: [
          BoxShadow(
            color: p.primary.withValues(alpha: 0.35),
            blurRadius: size * 0.5,
            offset: Offset(0, size * 0.16),
          ),
        ],
      ),
      alignment: Alignment.center,
      child: Text(
        'QS',
        style: TextStyle(
          color: Colors.white,
          fontSize: size * 0.34,
          fontWeight: FontWeight.w800,
          letterSpacing: -0.5,
        ),
      ),
    );
  }
}

/// A small, quiet control: an icon, a word, and a chevron. Used for the
/// language and the appearance on the lock screen, where they have to be
/// reachable without competing with the password field.
class QuietChip extends StatelessWidget {
  const QuietChip({super.key, required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = Skin.of(context);
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: Radii.pill,
        child: Padding(
          padding: const EdgeInsetsDirectional.only(start: 12, end: 10, top: 9, bottom: 9),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 17, color: p.muted),
              const SizedBox(width: 8),
              Text(label, style: TextStyle(color: p.muted, fontSize: 14, fontWeight: FontWeight.w600)),
              Icon(Icons.expand_more_rounded, size: 17, color: p.muted),
            ],
          ),
        ),
      ),
    );
  }
}

/// A status word in the colour that word means.
class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.label, required this.colour});

  final String label;
  final Color colour;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: colour.withValues(alpha: 0.14),
        borderRadius: Radii.pill,
        border: Border.all(color: colour.withValues(alpha: 0.34)),
      ),
      child: Text(
        label,
        style: TextStyle(color: colour, fontSize: 12.5, fontWeight: FontWeight.w700),
      ),
    );
  }
}

/// Children that arrive one after another rather than all at once.
///
/// The delay is small — a list that takes a second to appear is a list that is
/// slow. What it buys is the eye following the order of the page instead of
/// being handed the whole thing and having to find the top.
class Stagger extends StatelessWidget {
  const Stagger({
    super.key,
    required this.children,
    this.step = const Duration(milliseconds: 55),
    this.from = 14,
  });

  final List<Widget> children;
  final Duration step;
  final double from;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < children.length; i += 1)
          _Rise(delay: step * i, from: from, child: children[i]),
      ],
    );
  }
}

class _Rise extends StatefulWidget {
  const _Rise({required this.delay, required this.from, required this.child});

  final Duration delay;
  final double from;
  final Widget child;

  @override
  State<_Rise> createState() => _RiseState();
}

class _RiseState extends State<_Rise> with SingleTickerProviderStateMixin {
  late final AnimationController _in = AnimationController(vsync: this, duration: Motion.normal);

  @override
  void initState() {
    super.initState();
    Future<void>.delayed(widget.delay, () {
      if (mounted) _in.forward();
    });
  }

  @override
  void dispose() {
    _in.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final curve = CurvedAnimation(parent: _in, curve: Motion.curve);
    return AnimatedBuilder(
      animation: curve,
      builder: (context, child) => Opacity(
        opacity: curve.value,
        child: Transform.translate(
          offset: Offset(0, widget.from * (1 - curve.value)),
          child: child,
        ),
      ),
      child: widget.child,
    );
  }
}

/// A card that is a card: one border, one radius, no shadow stack.
class Panel extends StatelessWidget {
  const Panel({super.key, required this.child, this.padding = const EdgeInsets.all(18), this.onTap});

  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final p = Skin.of(context);
    final body = Padding(padding: padding, child: child);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: Radii.large,
        border: Border.all(color: p.border),
      ),
      child: onTap == null
          ? body
          : Material(
              color: Colors.transparent,
              child: InkWell(onTap: onTap, borderRadius: Radii.large, child: body),
            ),
    );
  }
}

/// Nothing here, said properly: a mark, a line, and what to do about it.
class Empty extends StatelessWidget {
  const Empty({super.key, required this.icon, required this.title, required this.body, this.action});

  final IconData icon;
  final String title;
  final String body;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final p = Skin.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: p.surfaceHigh,
                shape: BoxShape.circle,
                border: Border.all(color: p.border),
              ),
              child: Icon(icon, size: 30, color: p.muted),
            ),
            const SizedBox(height: 18),
            Text(title, style: Theme.of(context).textTheme.headlineSmall, textAlign: TextAlign.center),
            const SizedBox(height: 6),
            Text(body,
                style: Theme.of(context).textTheme.bodySmall, textAlign: TextAlign.center),
            if (action != null) ...[const SizedBox(height: 20), action!],
          ],
        ),
      ),
    );
  }
}
