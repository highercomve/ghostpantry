# JNI resolves these runtime classes by name (Oriel keeps the declared
# extension classes itself).
-keep class dev.oriel.** { *; }
# ONNX Runtime and LiteRT-LM: their native code finds their Java classes,
# constructors and fields by name (TensorInfo, OnnxTensor, the embedding
# results...). Their AARs don't keep them (ONNX Runtime 1.30's rules cover
# only telemetry; LiteRT-LM ships none), so R8 renamed or removed them and
# the first lookup aborted the app in release builds (SIGABRT in
# convertToTensorInfo / nativeComputeEmbedding, Play vitals for 0.1.3).
-keep class ai.onnxruntime.** { *; }
-keep class com.google.ai.edge.litertlm.** { *; }
