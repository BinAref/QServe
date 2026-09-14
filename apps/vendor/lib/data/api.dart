import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config.dart';

/// Something the database refused, in words rather than a status code.
class ApiError implements Exception {
  ApiError(this.message, {this.offline = false});

  final String message;
  final bool offline;

  @override
  String toString() => message;
}

/// One signed-in session: the tokens, and who they belong to.
class Session {
  Session({required this.accessToken, required this.refreshToken, required this.email});

  final String accessToken;
  final String refreshToken;
  final String email;

  factory Session.fromAuth(Map<String, dynamic> body) => Session(
        accessToken: body['access_token'] as String,
        refreshToken: body['refresh_token'] as String,
        email: ((body['user'] as Map?)?['email'] as String?) ?? vendorEmail,
      );
}

/// Everything this application says to the licence database.
///
/// Plain REST against PostgREST and GoTrue — the same calls the web console
/// made, because the rules they run into are the same rules. Nothing here
/// decides who may do what: the database does, in row level security and in
/// `security definer` functions that check `is_vendor()` for themselves. This
/// is a client, and a client that believes itself is not a security boundary.
class Api {
  Api({http.Client? client}) : _client = client ?? http.Client();

  final http.Client _client;
  Session? session;

  Map<String, String> get _base => {'apikey': anonKey, 'content-type': 'application/json'};

  Map<String, String> get _signedIn => {
        ..._base,
        'authorization': 'Bearer ${session!.accessToken}',
      };

  Future<http.Response> _send(Future<http.Response> Function() call) async {
    try {
      return await call().timeout(const Duration(seconds: 20));
    } catch (_) {
      // A phone in a basement and a project that has been deleted look the
      // same from here; both are "we could not ask", which is the thing the
      // person holding it needs to be told.
      throw ApiError('offline', offline: true);
    }
  }

  /* ------------------------------------------------------------- signing in */

  /// The email is the one compiled into this build. The vendor types a
  /// password and nothing else, because there is exactly one account this
  /// application can ever sign in as.
  Future<Session> signIn(String password) async {
    if (vendorEmail.isEmpty) throw ApiError('no-account');

    final res = await _send(() => _client.post(
          Uri.parse('$projectUrl/auth/v1/token?grant_type=password'),
          headers: _base,
          body: jsonEncode({'email': vendorEmail, 'password': password}),
        ));
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (body['access_token'] == null) throw ApiError('wrong-password');
    return session = Session.fromAuth(body);
  }

  /// Swap a saved refresh token for a working session. Supabase spends the old
  /// token and hands back a new one, so whatever kept it has to keep the new
  /// one too or the next unlock fails.
  Future<Session> resume(String refreshToken) async {
    final res = await _send(() => _client.post(
          Uri.parse('$projectUrl/auth/v1/token?grant_type=refresh_token'),
          headers: _base,
          body: jsonEncode({'refresh_token': refreshToken}),
        ));
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (body['access_token'] == null) throw ApiError('expired');
    return session = Session.fromAuth(body);
  }

  void signOut() => session = null;

  /// Proves the current password and sets a new one with the token that
  /// proved it, so somebody holding an unlocked console cannot change the
  /// password without knowing the old one.
  Future<void> changePassword(String current, String next) async {
    final proved = await signIn(current);
    final res = await _send(() => _client.put(
          Uri.parse('$projectUrl/auth/v1/user'),
          headers: {..._base, 'authorization': 'Bearer ${proved.accessToken}'},
          body: jsonEncode({'password': next}),
        ));
    if (res.statusCode >= 400) {
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      throw ApiError((body['msg'] ?? body['error_description'] ?? 'failed').toString());
    }
    // Changing it can retire the tokens already in the air, so take a clean
    // one now rather than finding out on the next tap.
    await signIn(next);
  }

  /* ---------------------------------------------------------------- reading */

  Future<dynamic> _rpc(String name, [Map<String, dynamic>? args]) async {
    final res = await _send(() => _client.post(
          Uri.parse('$projectUrl/rest/v1/rpc/$name'),
          headers: _signedIn,
          body: jsonEncode(args ?? {}),
        ));
    if (res.statusCode >= 400) throw ApiError(_shorten(res.body));

    final parsed = res.body.isEmpty ? null : jsonDecode(res.body);
    if (parsed is Map && parsed['error'] != null) {
      throw ApiError((parsed['detail'] ?? parsed['error']).toString());
    }
    return parsed;
  }

  /// Every restaurant with its licences, in one call, as the database chose to
  /// shape it.
  Future<List<Restaurant>> overview() async {
    final rows = await _rpc('vendor_overview');
    return (rows as List? ?? [])
        .map((row) => Restaurant.fromJson(row as Map<String, dynamic>))
        .toList();
  }

  /* ---------------------------------------------------------------- writing */

  /// Issue a licence, either for a restaurant already here or for a new one.
  ///
  /// The key is made on this device and sent with its hash. The database keeps
  /// both: the hash is what an activation is checked against, and the key
  /// itself is readable because a customer who has lost it rings the vendor,
  /// and "I cannot tell you your own key" is not an answer.
  Future<IssuedLicence> issue({
    String? restaurantId,
    String? restaurantName,
    String? contactName,
    String? contactPhone,
    String? contactEmail,
    String? country,
    String? notes,
    required String key,
    required String keyHash,
    required String keyHint,
  }) async {
    final out = await _rpc('issue_license', {
      'p_restaurant_id': restaurantId,
      'p_restaurant_name': restaurantName,
      'p_contact_name': contactName,
      'p_contact_phone': contactPhone,
      'p_contact_email': contactEmail,
      'p_country': country,
      'p_notes': notes,
      'p_license_type': 'PERPETUAL',
      'p_key': key,
      'p_key_hash': keyHash,
      'p_key_hint': keyHint,
      'p_actor': session?.email,
    }) as Map<String, dynamic>;

    return IssuedLicence(
      licenceId: out['licenseId'] as String,
      restaurantId: out['restaurantId'] as String,
      key: key,
    );
  }

  /// Takes the licence out of the database. The restaurant stops at its next
  /// check; the copy this device keeps is written before the call, not after,
  /// because a licence that is gone from both places is gone.
  Future<void> deleteLicence(String licenceId, String reason) =>
      _rpc('delete_license', {
        'p_license_id': licenceId,
        'p_reason': reason,
        'p_actor': session?.email,
      });

  /// Notes are an ordinary column on an ordinary row, so this is an ordinary
  /// update — row level security decides whether it lands.
  Future<void> setLicenceNotes(String licenceId, String notes) async {
    final res = await _send(() => _client.patch(
          Uri.parse('$projectUrl/rest/v1/licenses?license_id=eq.$licenceId'),
          headers: {..._signedIn, 'prefer': 'return=minimal'},
          body: jsonEncode({'notes': notes}),
        ));
    if (res.statusCode >= 400) throw ApiError(_shorten(res.body));
  }

  Future<void> setRestaurantNotes(String restaurantId, String notes) async {
    final res = await _send(() => _client.patch(
          Uri.parse('$projectUrl/rest/v1/restaurants?restaurant_id=eq.$restaurantId'),
          headers: {..._signedIn, 'prefer': 'return=minimal'},
          body: jsonEncode({'notes': notes}),
        ));
    if (res.statusCode >= 400) throw ApiError(_shorten(res.body));
  }

  static String _shorten(String body) {
    try {
      final parsed = jsonDecode(body) as Map<String, dynamic>;
      return (parsed['message'] ?? parsed['detail'] ?? parsed['hint'] ?? body).toString();
    } catch (_) {
      return body.length > 160 ? body.substring(0, 160) : body;
    }
  }
}

/* ----------------------------------------------------------------- the rows */

class IssuedLicence {
  IssuedLicence({required this.licenceId, required this.restaurantId, required this.key});

  final String licenceId;
  final String restaurantId;
  final String key;
}

enum LicenceStatus { pending, active, cancelled }

class Licence {
  Licence({
    required this.licenceId,
    required this.key,
    required this.keyHint,
    required this.status,
    required this.notes,
    required this.device,
    required this.deviceLabel,
    required this.activatedAt,
    required this.appVersion,
    required this.createdAt,
    required this.restaurantId,
    required this.restaurantName,
  });

  final String licenceId;
  final String? key;
  final String? keyHint;
  final LicenceStatus status;
  final String? notes;
  final String? device;
  final String? deviceLabel;
  final DateTime? activatedAt;
  final String? appVersion;
  final DateTime? createdAt;
  final String restaurantId;
  final String restaurantName;

  static LicenceStatus _status(String? raw) => switch (raw) {
        'ACTIVE' => LicenceStatus.active,
        'CANCELLED' => LicenceStatus.cancelled,
        _ => LicenceStatus.pending,
      };

  static DateTime? _at(dynamic raw) => raw == null ? null : DateTime.tryParse(raw as String);

  factory Licence.fromJson(Map<String, dynamic> row, String restaurantId, String restaurantName) =>
      Licence(
        licenceId: row['licenseId'] as String,
        key: row['key'] as String?,
        keyHint: row['keyHint'] as String?,
        status: _status(row['status'] as String?),
        notes: row['notes'] as String?,
        device: row['device'] as String?,
        deviceLabel: row['deviceLabel'] as String?,
        activatedAt: _at(row['activatedAt']),
        appVersion: row['appVersion'] as String?,
        createdAt: _at(row['createdAt']),
        restaurantId: restaurantId,
        restaurantName: restaurantName,
      );

  /// Everything a search box should look at: the restaurant, the identifiers,
  /// the key, and whatever the vendor wrote about it.
  String get haystack => [
        restaurantName,
        licenceId,
        restaurantId,
        key ?? '',
        keyHint ?? '',
        notes ?? '',
        deviceLabel ?? '',
      ].join(' ').toLowerCase();
}

class Restaurant {
  Restaurant({
    required this.restaurantId,
    required this.name,
    required this.contactName,
    required this.contactPhone,
    required this.contactEmail,
    required this.country,
    required this.notes,
    required this.createdAt,
    required this.licences,
  });

  final String restaurantId;
  final String name;
  final String? contactName;
  final String? contactPhone;
  final String? contactEmail;
  final String? country;
  final String? notes;
  final DateTime? createdAt;
  final List<Licence> licences;

  factory Restaurant.fromJson(Map<String, dynamic> row) {
    final id = row['restaurantId'] as String;
    final name = row['name'] as String? ?? id;
    return Restaurant(
      restaurantId: id,
      name: name,
      contactName: row['contactName'] as String?,
      contactPhone: row['contactPhone'] as String?,
      contactEmail: row['contactEmail'] as String?,
      country: row['country'] as String?,
      notes: row['notes'] as String?,
      createdAt: Licence._at(row['createdAt']),
      licences: ((row['licenses'] as List?) ?? [])
          .map((l) => Licence.fromJson(l as Map<String, dynamic>, id, name))
          .toList(),
    );
  }
}
