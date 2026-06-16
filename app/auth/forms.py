"""WTForms for authentication and profile management."""
from flask_wtf import FlaskForm
from wtforms import BooleanField, PasswordField, StringField, SelectField
from wtforms.validators import (
    DataRequired,
    Email,
    EqualTo,
    Length,
    Regexp,
    ValidationError,
)

from ..models import Role, User


_USERNAME_RE = r"^[A-Za-z0-9._-]+$"


class LoginForm(FlaskForm):
    username = StringField(
        "Username",
        validators=[DataRequired(), Length(min=3, max=64)],
        render_kw={"autocomplete": "username", "autocapitalize": "off"},
    )
    password = PasswordField(
        "Password",
        validators=[DataRequired(), Length(min=1, max=128)],
        render_kw={"autocomplete": "current-password"},
    )
    remember = BooleanField("Stay signed in")


class ChangePasswordForm(FlaskForm):
    current_password = PasswordField(
        "Current password", validators=[DataRequired(), Length(max=128)]
    )
    new_password = PasswordField(
        "New password",
        validators=[DataRequired(), Length(max=72)],
    )
    confirm = PasswordField(
        "Confirm new password",
        validators=[
            DataRequired(),
            EqualTo("new_password", message="Passwords must match."),
        ],
    )

    def validate_new_password(self, field):
        err = User.password_policy_error(field.data or "")
        if err:
            raise ValidationError(err)


class CreateUserForm(FlaskForm):
    username = StringField(
        "Username",
        validators=[
            DataRequired(),
            Length(min=3, max=64),
            Regexp(_USERNAME_RE, message="Letters, digits, . _ - only."),
        ],
    )
    email = StringField(
        "Email",
        validators=[DataRequired(), Email(), Length(max=254)],
    )
    role = SelectField(
        "Role",
        choices=[(r.value, r.label) for r in Role],
        validators=[DataRequired()],
    )
    # Admin-set: no strength policy (an admin may seed a temporary password
    # and pair it with "require change on first login").
    password = PasswordField(
        "Initial password",
        validators=[DataRequired(), Length(min=1, max=72)],
    )
    must_change_password = BooleanField(
        "Require password change on first login"
    )


class EditUserForm(FlaskForm):
    email = StringField(
        "Email", validators=[DataRequired(), Email(), Length(max=254)]
    )
    role = SelectField(
        "Role",
        choices=[(r.value, r.label) for r in Role],
        validators=[DataRequired()],
    )
    is_active = BooleanField("Active")
    # Admin-set reset: no strength policy (override). Blank keeps the
    # current password.
    new_password = PasswordField(
        "Reset password (optional)",
        validators=[Length(min=0, max=72)],
        render_kw={"placeholder": "Leave blank to keep current password"},
    )
