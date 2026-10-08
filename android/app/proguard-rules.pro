# oriel:proguard begin (AppOptions.android.proguard_rules; rewritten on every build)
# JNI resolves these runtime and extension classes by name.
-keep class dev.oriel.** { *; }
-keep class dev.ghostpantry.SystemAiExtension { *; }
-keep class dev.ghostpantry.EmbeddingGemmaExtension { *; }
# oriel:proguard end
