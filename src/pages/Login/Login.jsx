import React from "react";
import AuthForm from "../../components/AuthForm/AuthForm";

const Login = () => (
  <AuthForm
    helmetTitle="Sign In"
    heroEyebrow="Heritage Craftsmanship"
    heroHeadline="Timeless Elegance, Handcrafted for You."
    bottomText="New here? The same email creates your account."
    bottomLinkTo="/register"
    bottomLinkLabel="Create an account"
  />
);

export default Login;
