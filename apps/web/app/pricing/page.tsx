"use client";

import { useAuth } from "../../lib/AuthContext";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";

// In a real application, you would put the correct Stripe Price ID here
// This could be fetched from the backend or stored in environment variables
const STRIPE_PRICE_ID = process.env.NEXT_PUBLIC_STRIPE_PRICE_ID || "price_dummy"; 
const RAZORPAY_KEY_ID = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || "rzp_test_T5S5IrgDfwq6KP"; 

export default function PricingPage() {
  const { user, token } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleSubscribe = async () => {
    if (!user) {
      router.push("/login");
      return;
    }
    
    setLoading(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/stripe/create-checkout-session`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ priceId: STRIPE_PRICE_ID, mode: "subscription" })
      });
      
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert(data.error || "Failed to create checkout session");
      }
    } catch (err) {
      console.error(err);
      alert("Network error");
    } finally {
      setLoading(false);
    }
  };

  const handleRazorpaySubscribe = async () => {
    if (!user) {
      router.push("/login");
      return;
    }
    
    setLoading(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/razorpay/create-order`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ amount: 2900 }) // 2900 INR = 29.00
      });
      
      const data = await res.json();
      if (data.order && typeof window !== "undefined") {
        const options = {
          key: RAZORPAY_KEY_ID,
          amount: data.order.amount,
          currency: data.order.currency,
          name: "AI YouTube Automation",
          description: "Buy 100 Credits",
          order_id: data.order.id,
          handler: async function (response: any) {
            try {
              const verifyRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/razorpay/verify-payment`, {
                method: "POST",
                headers: { 
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${token}`
                },
                body: JSON.stringify({
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature
                })
              });
              
              const verifyData = await verifyRes.json();
              if (verifyData.success) {
                router.push("/payment/success");
              } else {
                alert("Payment verification failed");
              }
            } catch (err) {
              console.error(err);
              alert("Error verifying payment");
            }
          },
          prefill: {
            email: user.email,
          },
          theme: {
            color: "#2563EB",
          },
        };

        const razorpay = new (window as any).Razorpay(options);
        razorpay.on('payment.failed', function (response: any) {
          alert("Payment failed: " + response.error.description);
        });
        razorpay.open();
      } else {
        alert(data.error || "Failed to create Razorpay order");
      }
    } catch (err) {
      console.error(err);
      alert("Network error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center pt-20">
      <h1 className="text-4xl font-bold mb-10">Pricing</h1>
      <div className="bg-white p-8 rounded-lg shadow-md max-w-sm w-full text-center">
        <h2 className="text-2xl font-semibold mb-4">100 Credits</h2>
        <p className="text-gray-600 mb-6">Generate up to 100 automated videos</p>
        <div className="text-4xl font-bold mb-6">₹2900<span className="text-lg text-gray-500 font-normal"> / $29</span></div>
        <button  
          onClick={handleSubscribe}
          disabled={loading}
          className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors mb-3"
        >
          {loading ? "Preparing Checkout..." : "Pay with Stripe"}
        </button>
        <button 
          onClick={handleRazorpaySubscribe}
          disabled={loading}
          className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {loading ? "Preparing Checkout..." : "Pay with Razorpay (INR)"}
        </button>
      </div>
    </div>
  );
}
