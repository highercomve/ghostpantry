# Google Play release assets

- Application ID: `dev.ghostpantry.app`
- Initial internal release: 0.1.0 (version code 100), published 2026-10-07.
- GitHub preview: https://github.com/highercomve/ghostpantry/releases/tag/v0.1.0
- Closed Alpha: version 100 submitted for review on 2026-10-07; Chile, GhostPantry owner tester list.
- Website: https://highercomve.github.io/ghostpantry/
- Privacy: https://highercomve.github.io/ghostpantry/privacy/
- Internal test opt-in: https://play.google.com/apps/internaltest/4701720946126812699

The listing text is in listing.md. Assets include the 512 px icon, 1024 × 500 feature graphic, and native Android emulator screenshots at 1080 × 1920.

The upload certificate is play-upload-certificate.pem. The private upload keystore and password are stored outside this repository in ~/.config/ghostpantry/signing/ with restricted permissions. Back them up securely; never commit them. Future Play uploads must use this upload key, not the debug signing key.

Initial validation passed Android unit tests, release APK/AAB builds, AAB signature verification, and 16 KB ELF load alignment checks for every native library. The AAB is approximately 91 MB; device downloads contain only the matching ABI.

Production access requires a closed test with at least 12 opted-in testers for at least 14 days, followed by Google's production-access review. Internal testing does not satisfy that requirement.

- Internal update: 0.1.2 (version code 102), published 2026-10-08. Guided food review, grouped quantities, system theme support and scan timing details.
- Latest GitHub preview: https://github.com/highercomve/ghostpantry/releases/tag/v0.1.2
