# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in C:\Users\Andre\AppData\Local\Android\Sdk/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# ===== Relatórios de falha legíveis (Play Console) =====
# Mantém nomes de arquivo e números de linha nos stack traces ofuscados.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ===== Picasso / OkHttp / Okio =====
-dontwarn com.squareup.okhttp.**
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.codehaus.mojo.animal_sniffer.*
-dontwarn javax.annotation.**

# ===== Google Play Billing =====
-keep class com.android.vending.billing.** { *; }

# ===== Appodeal SDK 4.x =====
-keep class com.appodeal.ads.** { *; }
-dontwarn com.appodeal.ads.**
-keep class com.explorestack.** { *; }
-dontwarn com.explorestack.**
# Redes mediadas (AdMob/AppLovin/BidMachine/Bidon)
-keep class com.google.android.gms.ads.** { *; }
-dontwarn com.google.android.gms.ads.**
-keep class com.applovin.** { *; }
-dontwarn com.applovin.**
-keep class io.bidmachine.** { *; }
-dontwarn io.bidmachine.**
-keep class org.bidon.** { *; }
-dontwarn org.bidon.**
