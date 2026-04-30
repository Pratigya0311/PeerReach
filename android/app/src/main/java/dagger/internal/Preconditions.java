package dagger.internal;

/** Compatibility stub — Bridgefy SDK was compiled against this old Dagger API. */
public final class Preconditions {

    public static <T> T checkNotNull(T reference) {
        if (reference == null) {
            throw new NullPointerException("Expected non-null value.");
        }
        return reference;
    }

    public static <T> T checkNotNull(T reference, Object errorMessage) {
        if (reference == null) {
            throw new NullPointerException(String.valueOf(errorMessage));
        }
        return reference;
    }

    public static <T> T checkNotNullFromProvides(T reference) {
        if (reference == null) {
            throw new NullPointerException("@Provides method returned null.");
        }
        return reference;
    }

    public static <T> T checkNotNullFromComponent(T reference) {
        if (reference == null) {
            throw new NullPointerException("Component returned null.");
        }
        return reference;
    }

    public static void checkBuilderRequirement(Object requirement, Class<?> clazz) {
        if (requirement == null) {
            throw new IllegalStateException(
                clazz.getCanonicalName() + " must be set");
        }
    }

    private Preconditions() {}
}
