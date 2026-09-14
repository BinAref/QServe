import 'package:flutter/widgets.dart';

/// What this application says, in the three languages QServe ships.
///
/// Written by hand rather than generated. The generator earns its keep on
/// eight hundred strings across five front-ends; here it would add a build
/// step, a watch mode and a class nobody can read, to save typing a map. The
/// restaurant's own translations stay where they are, in `locales/*.json`.
///
/// A device set to anything else — French, Urdu, the tablet that arrived in
/// Korean — gets English. That is the rule, stated once, in [resolve].
class Strings {
  const Strings._(this.locale, this._of);

  final Locale locale;
  final Map<String, String> _of;

  bool get rtl => locale.languageCode == 'ar';

  String operator [](String key) => _of[key] ?? key;

  /// With one value substituted, for the handful of lines that need it.
  String fill(String key, Map<String, String> values) {
    var text = this[key];
    values.forEach((name, value) => text = text.replaceAll('{$name}', value));
    return text;
  }

  static const supported = [Locale('en'), Locale('ar'), Locale('tr')];

  /// The languages offered in the picker, in their own names — a person
  /// looking for Arabic is looking for العربية, not for "Arabic".
  static const names = {'en': 'English', 'ar': 'العربية', 'tr': 'Türkçe'};

  /// The device's language if this application speaks it, English otherwise.
  static Locale resolve(Locale? device) {
    if (device == null) return const Locale('en');
    final match = supported.where((l) => l.languageCode == device.languageCode);
    return match.isEmpty ? const Locale('en') : match.first;
  }

  static Strings of(BuildContext context) => Localizations.of<Strings>(context, Strings)!;

  static Strings forLocale(Locale locale) => Strings._(locale, _tables[locale.languageCode]!);

  static const _tables = {'en': _en, 'ar': _ar, 'tr': _tr};
}

class StringsDelegate extends LocalizationsDelegate<Strings> {
  const StringsDelegate();

  @override
  bool isSupported(Locale locale) => Strings._tables.containsKey(locale.languageCode);

  @override
  Future<Strings> load(Locale locale) async => Strings.forLocale(locale);

  @override
  bool shouldReload(StringsDelegate old) => false;
}

const _en = {
  'app.name': 'QServe Licences',
  'app.tagline': 'The vendor console',

  'lock.prompt': 'Enter your password',
  'lock.password': 'Password',
  'lock.open': 'Open',
  'lock.biometric': 'Use fingerprint or face',
  'lock.biometric_reason': 'Open the licence console',
  'lock.wrong': 'That password is not right.',
  'lock.remaining': '{n} attempts left today.',
  'lock.locked_title': 'Too many attempts',
  'lock.locked_body': 'Five wrong passwords. Try again in {time}.',
  'lock.no_account': 'This build was made without an account, so no password can open it.',
  'lock.offline': 'No connection. The password is checked against the licence database.',
  'lock.language': 'Language',
  'lock.theme': 'Appearance',

  'theme.system': 'Match the device',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'language.system': 'Match the device',

  'home.title': 'Licences',
  'home.search': 'Search a restaurant, a licence, a key',
  'home.empty_title': 'No licences yet',
  'home.empty_body': 'Issue the first one and its key appears here to copy.',
  'home.none_found': 'Nothing matches that.',
  'home.issue': 'Issue a licence',
  'home.deleted': 'Deleted licences',
  'home.deleted_body': 'Kept on this device after they left the database.',
  'home.export': 'Download everything',
  'home.account': 'Account',
  'home.refresh': 'Refresh',

  'status.pending': 'Not activated',
  'status.active': 'Active',
  'status.cancelled': 'Cancelled',

  'issue.title': 'New licence',
  'issue.intro': 'Creates the restaurant and issues its first licence.',
  'issue.existing': 'Another licence for a restaurant already here',
  'issue.restaurant': 'Restaurant name',
  'issue.contact': 'Contact name',
  'issue.phone': 'Phone',
  'issue.email': 'Email',
  'issue.country': 'Country',
  'issue.notes': 'Notes',
  'issue.notes_hint': 'What was agreed, what was paid, who asked.',
  'issue.create': 'Create and issue',
  'issue.done': 'Licence issued',
  'issue.key_once': 'Copy this key now. It is stored as a hash, so it cannot be shown again.',
  'issue.copy': 'Copy the key',
  'issue.copied': 'Copied',

  'licence.title': 'Licence',
  'licence.restaurant': 'Restaurant',
  'licence.issued': 'Issued',
  'licence.activated': 'Activated',
  'licence.device': 'Device',
  'licence.key_hint': 'Key ends in',
  'licence.notes': 'Notes',
  'licence.notes_saved': 'Notes saved',
  'licence.cancel': 'Cancel this licence',
  'licence.cancel_warn':
      'It leaves the database and the restaurant stops on its next check. A copy stays on this device.',
  'licence.cancel_reason': 'Reason (kept in the log)',
  'licence.cancelled': 'Cancelled',
  'licence.new_for_this': 'Issue another for this restaurant',

  'account.title': 'Account',
  'account.password': 'Change the password',
  'account.current': 'Current password',
  'account.next': 'New password',
  'account.again': 'New password again',
  'account.change': 'Change it',
  'account.changed': 'Password changed.',
  'account.mismatch': 'The two new passwords are not the same.',
  'account.wrong_current': 'That is not the current password.',
  'account.same': 'That is the password you already have.',
  'account.biometric': 'Fingerprint and face',
  'account.biometric_on': 'On. Your fingerprint or face opens this console.',
  'account.biometric_off': 'Off. The password is asked for every time.',
  'account.biometric_none': 'This device has no fingerprint or face set up.',
  'account.enable': 'Turn it on',
  'account.disable': 'Turn it off',
  'account.signout': 'Sign out',
  'account.signout_body': 'Asks for the password again next time.',

  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.close': 'Close',
  'common.retry': 'Try again',
  'common.none': 'None',
  'common.offline': 'No connection to the licence database.',
  'common.failed': 'That did not work.',
};

const _ar = {
  'app.name': 'تراخيص QServe',
  'app.tagline': 'كونسول المورّد',

  'lock.prompt': 'أدخل كلمة السر',
  'lock.password': 'كلمة السر',
  'lock.open': 'دخول',
  'lock.biometric': 'استخدم البصمة أو الوجه',
  'lock.biometric_reason': 'فتح كونسول التراخيص',
  'lock.wrong': 'كلمة السر غير صحيحة.',
  'lock.remaining': 'بقيت {n} محاولات اليوم.',
  'lock.locked_title': 'محاولات كثيرة',
  'lock.locked_body': 'خمس كلمات سر خاطئة. حاول بعد {time}.',
  'lock.no_account': 'بُنيت هذه النسخة بلا حساب، فلا كلمة سر تفتحها.',
  'lock.offline': 'لا اتصال. كلمة السر تُفحص في قاعدة التراخيص.',
  'lock.language': 'اللغة',
  'lock.theme': 'المظهر',

  'theme.system': 'حسب الجهاز',
  'theme.light': 'فاتح',
  'theme.dark': 'داكن',
  'language.system': 'حسب الجهاز',

  'home.title': 'التراخيص',
  'home.search': 'ابحث عن مطعم أو ترخيص أو مفتاح',
  'home.empty_title': 'لا تراخيص بعد',
  'home.empty_body': 'أصدر الأول ويظهر مفتاحه هنا لتنسخه.',
  'home.none_found': 'لا شيء يطابق ذلك.',
  'home.issue': 'إصدار ترخيص',
  'home.deleted': 'التراخيص المحذوفة',
  'home.deleted_body': 'محفوظة على هذا الجهاز بعد خروجها من قاعدة البيانات.',
  'home.export': 'تنزيل كل شيء',
  'home.account': 'الحساب',
  'home.refresh': 'تحديث',

  'status.pending': 'غير مفعّل',
  'status.active': 'فعّال',
  'status.cancelled': 'ملغى',

  'issue.title': 'ترخيص جديد',
  'issue.intro': 'يُنشئ المطعم ويُصدر ترخيصه الأول.',
  'issue.existing': 'ترخيص آخر لمطعم موجود',
  'issue.restaurant': 'اسم المطعم',
  'issue.contact': 'اسم جهة الاتصال',
  'issue.phone': 'الهاتف',
  'issue.email': 'البريد',
  'issue.country': 'الدولة',
  'issue.notes': 'ملاحظات',
  'issue.notes_hint': 'ما اتُّفق عليه، وما دُفع، ومن طلب.',
  'issue.create': 'إنشاء وإصدار',
  'issue.done': 'صدر الترخيص',
  'issue.key_once': 'انسخ المفتاح الآن. يُخزَّن كبصمة، فلا يمكن عرضه ثانية.',
  'issue.copy': 'انسخ المفتاح',
  'issue.copied': 'نُسخ',

  'licence.title': 'الترخيص',
  'licence.restaurant': 'المطعم',
  'licence.issued': 'صدر',
  'licence.activated': 'فُعِّل',
  'licence.device': 'الجهاز',
  'licence.key_hint': 'المفتاح ينتهي بـ',
  'licence.notes': 'ملاحظات',
  'licence.notes_saved': 'حُفظت الملاحظات',
  'licence.cancel': 'إلغاء هذا الترخيص',
  'licence.cancel_warn':
      'يخرج من قاعدة البيانات ويتوقف المطعم عند فحصه التالي. تبقى نسخة على هذا الجهاز.',
  'licence.cancel_reason': 'السبب (يُحفظ في السجل)',
  'licence.cancelled': 'أُلغي',
  'licence.new_for_this': 'أصدر آخر لهذا المطعم',

  'account.title': 'الحساب',
  'account.password': 'تغيير كلمة السر',
  'account.current': 'كلمة السر الحالية',
  'account.next': 'كلمة السر الجديدة',
  'account.again': 'كلمة السر الجديدة ثانية',
  'account.change': 'غيّرها',
  'account.changed': 'تغيّرت كلمة السر.',
  'account.mismatch': 'الكلمتان الجديدتان غير متطابقتين.',
  'account.wrong_current': 'هذه ليست كلمة السر الحالية.',
  'account.same': 'هذه كلمة السر التي لديك أصلاً.',
  'account.biometric': 'البصمة والوجه',
  'account.biometric_on': 'مفعّلة. بصمتك أو وجهك يفتح هذا الكونسول.',
  'account.biometric_off': 'معطّلة. تُطلب كلمة السر في كل مرة.',
  'account.biometric_none': 'لا بصمة ولا وجه مُعدّان على هذا الجهاز.',
  'account.enable': 'فعّلها',
  'account.disable': 'عطّلها',
  'account.signout': 'تسجيل الخروج',
  'account.signout_body': 'تُطلب كلمة السر في المرة القادمة.',

  'common.cancel': 'إلغاء',
  'common.save': 'حفظ',
  'common.close': 'إغلاق',
  'common.retry': 'أعد المحاولة',
  'common.none': 'لا شيء',
  'common.offline': 'لا اتصال بقاعدة التراخيص.',
  'common.failed': 'لم ينجح ذلك.',
};

const _tr = {
  'app.name': 'QServe Lisansları',
  'app.tagline': 'Satıcı konsolu',

  'lock.prompt': 'Parolanızı girin',
  'lock.password': 'Parola',
  'lock.open': 'Aç',
  'lock.biometric': 'Parmak izi veya yüz kullan',
  'lock.biometric_reason': 'Lisans konsolunu aç',
  'lock.wrong': 'Parola doğru değil.',
  'lock.remaining': 'Bugün {n} deneme kaldı.',
  'lock.locked_title': 'Çok fazla deneme',
  'lock.locked_body': 'Beş hatalı parola. {time} sonra tekrar deneyin.',
  'lock.no_account': 'Bu sürüm hesapsız derlendi, hiçbir parola açamaz.',
  'lock.offline': 'Bağlantı yok. Parola lisans veritabanında denetlenir.',
  'lock.language': 'Dil',
  'lock.theme': 'Görünüm',

  'theme.system': 'Cihaza uy',
  'theme.light': 'Açık',
  'theme.dark': 'Koyu',
  'language.system': 'Cihaza uy',

  'home.title': 'Lisanslar',
  'home.search': 'Restoran, lisans veya anahtar ara',
  'home.empty_title': 'Henüz lisans yok',
  'home.empty_body': 'İlkini verin; anahtarı kopyalamanız için burada görünür.',
  'home.none_found': 'Eşleşen bir şey yok.',
  'home.issue': 'Lisans ver',
  'home.deleted': 'Silinen lisanslar',
  'home.deleted_body': 'Veritabanından çıktıktan sonra bu cihazda tutulur.',
  'home.export': 'Her şeyi indir',
  'home.account': 'Hesap',
  'home.refresh': 'Yenile',

  'status.pending': 'Etkin değil',
  'status.active': 'Etkin',
  'status.cancelled': 'İptal edildi',

  'issue.title': 'Yeni lisans',
  'issue.intro': 'Restoranı oluşturur ve ilk lisansını verir.',
  'issue.existing': 'Buradaki bir restoran için başka bir lisans',
  'issue.restaurant': 'Restoran adı',
  'issue.contact': 'İlgili kişi',
  'issue.phone': 'Telefon',
  'issue.email': 'E-posta',
  'issue.country': 'Ülke',
  'issue.notes': 'Notlar',
  'issue.notes_hint': 'Ne anlaşıldı, ne ödendi, kim istedi.',
  'issue.create': 'Oluştur ve ver',
  'issue.done': 'Lisans verildi',
  'issue.key_once': 'Anahtarı şimdi kopyalayın. Özet olarak saklanır, tekrar gösterilemez.',
  'issue.copy': 'Anahtarı kopyala',
  'issue.copied': 'Kopyalandı',

  'licence.title': 'Lisans',
  'licence.restaurant': 'Restoran',
  'licence.issued': 'Verildi',
  'licence.activated': 'Etkinleştirildi',
  'licence.device': 'Cihaz',
  'licence.key_hint': 'Anahtarın sonu',
  'licence.notes': 'Notlar',
  'licence.notes_saved': 'Notlar kaydedildi',
  'licence.cancel': 'Bu lisansı iptal et',
  'licence.cancel_warn':
      'Veritabanından çıkar ve restoran bir sonraki denetimde durur. Bu cihazda bir kopya kalır.',
  'licence.cancel_reason': 'Gerekçe (kayda geçer)',
  'licence.cancelled': 'İptal edildi',
  'licence.new_for_this': 'Bu restoran için bir tane daha ver',

  'account.title': 'Hesap',
  'account.password': 'Parolayı değiştir',
  'account.current': 'Mevcut parola',
  'account.next': 'Yeni parola',
  'account.again': 'Yeni parola tekrar',
  'account.change': 'Değiştir',
  'account.changed': 'Parola değişti.',
  'account.mismatch': 'İki yeni parola aynı değil.',
  'account.wrong_current': 'Bu, mevcut parola değil.',
  'account.same': 'Bu zaten kullandığınız parola.',
  'account.biometric': 'Parmak izi ve yüz',
  'account.biometric_on': 'Açık. Parmak iziniz veya yüzünüz bu konsolu açar.',
  'account.biometric_off': 'Kapalı. Her seferinde parola sorulur.',
  'account.biometric_none': 'Bu cihazda kurulu parmak izi veya yüz yok.',
  'account.enable': 'Aç',
  'account.disable': 'Kapat',
  'account.signout': 'Çıkış yap',
  'account.signout_body': 'Bir dahaki sefere parola sorar.',

  'common.cancel': 'İptal',
  'common.save': 'Kaydet',
  'common.close': 'Kapat',
  'common.retry': 'Tekrar dene',
  'common.none': 'Yok',
  'common.offline': 'Lisans veritabanına bağlantı yok.',
  'common.failed': 'Bu işe yaramadı.',
};
