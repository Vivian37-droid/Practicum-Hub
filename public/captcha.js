import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const login=document.querySelector('#login');
const forgot=document.querySelector('#forgotPassword');
const notice=document.querySelector('#authErr');

function message(text,kind='danger'){
  notice.className=`notice ${kind}`;
  notice.textContent=text;
}
function token(){return document.querySelector('[name="cf-turnstile-response"]')?.value||'';}
function reset(){if(window.turnstile){try{window.turnstile.reset();}catch{}}}
function verify(){const value=token();if(!value)message('Complete the security check before continuing.');return value;}
function client(){return createClient(window.__SUPABASE_URL__,window.__SUPABASE_ANON_KEY__);}

login.addEventListener('submit',async event=>{
  event.preventDefault();event.stopImmediatePropagation();
  const captchaToken=verify();if(!captchaToken)return;
  const submit=login.querySelector('button[type="submit"],button:not([type])');
  try{
    submit.disabled=true;
    const {error}=await client().auth.signInWithPassword({email:document.querySelector('#email').value,password:document.querySelector('#password').value,options:{captchaToken}});
    if(error)throw error;
    location.reload();
  }catch(error){message(error.message||'Sign-in could not be completed.');reset();submit.disabled=false;}
},true);

forgot.addEventListener('click',async event=>{
  event.preventDefault();event.stopImmediatePropagation();
  const email=document.querySelector('#email').value.trim();
  if(!email){message('Enter your email address first, then select “Forgot password?”.');document.querySelector('#email').focus();return;}
  const captchaToken=verify();if(!captchaToken)return;
  try{
    forgot.disabled=true;
    const {error}=await client().auth.resetPasswordForEmail(email,{redirectTo:`${location.origin}/`,captchaToken});
    if(error)throw error;
    message('Password-reset email sent. Open the newest email and use its link once.','info');
  }catch(error){message(error.message||'The password-reset email could not be sent.');reset();}
  finally{forgot.disabled=false;}
},true);
